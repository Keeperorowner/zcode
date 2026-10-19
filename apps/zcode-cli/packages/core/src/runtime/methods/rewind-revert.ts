// zcode-oss: message-rewind Phase 3 —— rewind 的撤销/重做（redo），对齐 Kilo unrevert。
// 设计（docs/design/message-rewind.md §Phase 3）：
// - undo 日志（durable sidecar，位于影子仓目录旁 undo-journal/<sessionId>.json）记录每次
//   rewind 前的 revert 状态、当时的工作区整树 hash 等撤销点；
// - redo = 恢复撤销点：setRevert/clearRevert 回滚分支状态（消息 append-only 未删，前缀
//   恢复即整分支回归）→ 如撤销时动过文件则整树恢复到 pre-undo 快照 → 追加
//   RewindReverted 事件（冷合并据此抑制被撤销的 RewindTriggered，投影按恢复后的
//   分支重建）→ 由宿主强制投影 rehydrate（订阅者 resync 收到全新快照）；
// - 语义约束（Kilo 同款）：新 prompt 开始即清空 undo 日志——重做只在"撤销后未发新消息"
//   窗口内可用，保证恢复的前缀与撤销后可能的新分支不合并。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  selectActiveConversationBranch,
  SessionEventType,
  traceContextToLogContext,
  type MessageId,
  type TraceContext,
} from "../deps.js";
import type { SessionRevert } from "@zcode/contracts";
import type {
  ConversationRewindRestoreResult,
  RewindUndoPoint,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { rebuildConversationDerivedState } from "./rewind-message.js";
import {
  ensureShadowRepo,
  restoreWorkspaceTreeToHash,
  shadowRepoFor,
  writeCurrentTree,
} from "./turn-workspace-snapshot.js";

interface RewindUndoJournalEntry extends RewindUndoPoint {
  createdAt: number;
  filesRestored: boolean;
  id: string;
  postRewindActiveMessageCount: number;
  postRewindBranchGeneration: number;
  revertedRewindId: string;
  targetMessageId: MessageId;
}

function journalPath(workspaceRoot: string, sessionId: string): string {
  const repo = shadowRepoFor(workspaceRoot);
  return path.join(repo.gitDir, "undo-journal", `${sessionId}.json`);
}

async function readJournal(
  this: AgentRuntimeInternal,
): Promise<RewindUndoJournalEntry[]> {
  try {
    const raw = await readFile(journalPath(this.workspaceRoot, this.sessionId), "utf8");
    const parsed = JSON.parse(raw) as { entries?: RewindUndoJournalEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

async function writeJournal(
  this: AgentRuntimeInternal,
  entries: RewindUndoJournalEntry[],
): Promise<void> {
  const file = journalPath(this.workspaceRoot, this.sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ entries }, null, 1), "utf8");
}

/**
 * 撤销点采集：rewind 执行前调用（不落盘）。previousRevert 是当时 store 的完整
 * revert 状态（null = 从未 rewind）；preRewindTreeHash 是当时的工作区整树
 * （非 git 工作区为 null）。preActiveMessageCount 供 UI 横幅"已还原 N 条消息"。
 */
export async function captureRewindUndoPoint(
  this: AgentRuntimeInternal,
): Promise<RewindUndoPoint | null> {
  if (!this.sessionStore) return null;
  const session = await this.sessionStore.getSession(this.sessionId);
  const persistedMessages = await this.sessionStore.messages({ sessionID: this.sessionId });
  const activeMessages = selectActiveConversationBranch(persistedMessages, {
    branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session?.revert?.createdMessageID,
    rewindKeptMessageIds: session?.revert?.keptMessageIDs,
    rewindTargetMessageId: session?.revert?.targetMessageID,
  });
  let preRewindTreeHash: string | null = null;
  try {
    const repo = shadowRepoFor(this.workspaceRoot);
    if (await ensureShadowRepo(repo)) {
      preRewindTreeHash = await writeCurrentTree(repo, `undo-${this.sessionId}`);
    }
  } catch {
    // 树采集失败只影响文件级 redo；对话级 redo 仍可用。
  }
  return {
    preActiveMessageCount: activeMessages.length,
    preRewindBranchGeneration: session?.revert?.branchGeneration ?? 0,
    // 结构化拷贝，避免后续 store 内部对象突变影响日志。
    previousRevert: session?.revert
      ? (JSON.parse(JSON.stringify(session.revert)) as SessionRevert)
      : null,
    preRewindTreeHash,
  };
}

/** rewind 成功提交后落盘撤销点（filesRestored 标记撤销时是否动过工作区）。 */
export async function commitRewindUndoPoint(
  this: AgentRuntimeInternal,
  input: {
    point: RewindUndoPoint;
    revertedRewindId: string;
    targetMessageId: MessageId;
    postRewindActiveMessageCount: number;
    filesRestored: boolean;
  },
): Promise<void> {
  const entries = await readJournal.call(this);
  entries.push({
    ...input.point,
    createdAt: Date.now(),
    id: `undo_${randomUUID()}`,
    revertedRewindId: input.revertedRewindId,
    // ConversationRewindResult 不回传 branchGeneration；由撤销点的 pre 代际推算（rewind 恰好 +1）。
    postRewindBranchGeneration: input.point.preRewindBranchGeneration + 1,
    postRewindActiveMessageCount: input.postRewindActiveMessageCount,
    targetMessageId: input.targetMessageId,
    filesRestored: input.filesRestored,
  });
  await writeJournal.call(this, entries);
}

/**
 * 新 prompt 开始时作废全部撤销点（Kilo 语义：重做只在"撤销后未发新消息"窗口内可用）。
 * 失败静默——不能阻塞正常 turn。
 */
export async function clearRewindUndoJournal(this: AgentRuntimeInternal): Promise<void> {
  try {
    await rm(journalPath(this.workspaceRoot, this.sessionId), { force: true });
  } catch {
    // 清理失败只影响 redo 窗口判定，不影响主流程。
  }
}

/**
 * redo：撤销最近一次 rewind（含其全部效果——对话分支、被截断消息、撤销时的文件回滚）。
 * 成功后由宿主（v4 handler）强制投影 rehydrate，订阅者经 resync 收到完整分支快照。
 */
export async function undoConversationRewind(
  this: AgentRuntimeInternal,
  options: { traceContext: TraceContext },
): Promise<ConversationRewindRestoreResult> {
  if (!this.sessionStore) {
    return { restored: false, reason: "no_session_store" };
  }
  const entries = await readJournal.call(this);
  const entry = entries.at(-1);
  if (!entry) {
    return { restored: false, reason: "no_undo_entry" };
  }
  const session = await this.sessionStore.getSession(this.sessionId);
  const currentGeneration = session?.revert?.branchGeneration ?? 0;
  // D1 修复：代数单调递增（rewind/redo 各 +1），严格相等会在"连续 redo"时把更深的
  // 栈目误判 stale。弹栈严格 LIFO（只有 undo 压、redo 弹），代数 >= 记录值即安全；
  // 小于记录值只可能来自异常路径（外部改写 revert），维持拒绝。
  if (currentGeneration < entry.postRewindBranchGeneration) {
    return { restored: false, reason: "stale_undo_entry" };
  }

  const nextGeneration = currentGeneration + 1;
  // 1) 文件侧：撤销时若整树回滚过，redo 恢复到 pre-undo 快照。
  let filesRestoredCount: number | undefined;
  if (entry.filesRestored && entry.preRewindTreeHash) {
    const treeResult = await restoreWorkspaceTreeToHash.call(this, entry.preRewindTreeHash);
    if (!treeResult.restored) {
      return { restored: false, reason: "git_failed", message: treeResult.message };
    }
    filesRestoredCount = treeResult.files ?? 0;
  }

  // 2) 分支侧：恢复撤销前的 revert 状态（kept 前缀回归 → 被截断消息全部回到 active 分支）。
  const preRewindRevert = entry.previousRevert as SessionRevert | null;
  if (preRewindRevert) {
    await this.sessionStore.setRevert({
      sessionID: this.sessionId,
      revert: { ...preRewindRevert, branchGeneration: nextGeneration },
    });
  } else {
    await this.sessionStore.clearRevert(this.sessionId);
  }
  this.branchGeneration = nextGeneration;
  this.runtimeTaskRegistry.setActiveBranchGeneration?.(nextGeneration);

  // 3) 派生状态重建：按恢复后的分支选项水合历史/读文件状态/上下文前缀。
  const persistedMessages = await this.sessionStore.messages({ sessionID: this.sessionId });
  const activeMessages = selectActiveConversationBranch(persistedMessages, {
    branchCutAfterMessageId: preRewindRevert?.branchCutAfterMessageID,
    rewindCreatedMessageId: preRewindRevert?.createdMessageID,
    rewindKeptMessageIds: preRewindRevert?.keptMessageIDs,
    rewindTargetMessageId: preRewindRevert?.targetMessageID,
  });
  // 该次 rewind 截掉的消息数 = 撤销点前后 active 计数差（日志窗口保证期间无新消息）。
  const restoredMessageCount = Math.max(
    0,
    entry.preActiveMessageCount - entry.postRewindActiveMessageCount,
  );
  await rebuildConversationDerivedState.call(this, {
    branchCutAfterMessageId:
      (preRewindRevert?.branchCutAfterMessageID ?? persistedMessages.at(-1)?.info.id) as MessageId,
    keptMessageIds: activeMessages.map((message) => message.info.id as MessageId),
    persistedMessages,
    targetMessageId: (preRewindRevert?.targetMessageID ??
      activeMessages.at(-1)?.info.id ??
      persistedMessages.at(-1)!.info.id) as MessageId,
    traceContext: options.traceContext,
  });

  // 4) 事件：RewindReverted 进日志——冷合并据此抑制被撤销的 RewindTriggered。
  const event = this.createEvent(
    SessionEventType.RewindReverted,
    {
      branchGeneration: nextGeneration,
      filesRestored: entry.filesRestored === true,
      restoredMessageCount,
      revertedRewindId: entry.revertedRewindId,
    },
    options.traceContext,
  );
  await this.appendEvent(event, options.traceContext);

  // 5) 弹出撤销点并落盘；剩余栈深回传给 UI（连续 redo 的横幅依据）。
  entries.pop();
  await writeJournal.call(this, entries);
  const entriesRemaining = entries.length;

  this.logger?.info?.("zcode-oss rewind redo applied", {
    ...traceContextToLogContext(options.traceContext),
    event: "rewind_revert.completed",
    module: "core.runtime.rewind_revert",
    filesRestoredCount,
    restoredMessageCount,
    sessionId: this.sessionId,
  });

  return {
    entriesRemaining,
    filesRestored: filesRestoredCount,
    restored: true,
    restoredMessageCount,
    targetMessageId: entry.targetMessageId,
  };
}
