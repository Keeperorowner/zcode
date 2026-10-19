// zcode-oss: message-rewind (docs/design/message-rewind.md)
// rewindConversation：任意历史 user 消息的对话级回滚。
// 与 editUserQuery 的关系：edit = rewind 截断 + 重发新文本（latest-only 守卫）；
// 本命令 = 只截断不重发，且不限制 latest（任意已登记 user 实体均可）。
// 文件侧 Phase 1 固定 preserve（不动工作区）；组合回滚待 Phase 2 全量快照后放开。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { RewindStrategy, traceContextToLogContext, type MessageId } from "@zcode/contracts";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { preemptActiveTurnAndWait } from "./session-flow.js";

const CONVERSATION_COMMAND_LOG_MODULE = "bootstrap.zcode_protocol_v4.commands";
const REWIND_CONVERSATION_COMPLETED_EVENT = "conversation.command.rewind_conversation.completed";

/** target 无法解析到已登记 user 实体（非 realUser 行 / 迟到 / 无投影）。 */
class V4RewindTargetError extends Error {
  readonly reasonCode = "guard.rewindTargetUnavailable";

  constructor(targetRowId: number) {
    super(`rewindConversation targetRowId ${targetRowId} 无法解析到已登记的 user 实体`);
    this.name = "V4RewindTargetError";
  }
}

/** Phase 2：工作区恢复失败（无快照 / 非 git 工作区 / git 错误），文件与对话都不动。 */
class V4RewindWorkspaceRestoreError extends Error {
  readonly reasonCode = "guard.rewindWorkspaceRestoreFailed";

  constructor(reason: string, message?: string) {
    super(
      `rewindConversation 工作区快照恢复失败: ${reason}${message ? ` (${message})` : ""}`,
    );
    this.name = "V4RewindWorkspaceRestoreError";
  }
}

async function rewindConversation(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["rewindConversation"];
  const record = requireRecord(host, envelope.sessionId);
  // 翻译在 preempt 之前完成：preempt 触发的 turn 终态事件会推进投影，
  // 先解析再抢占，与 editUserQuery 的顺序一致。
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "rewindConversation",
  );
  if (!resolution?.ok || !resolution.editTarget) {
    throw new V4RewindTargetError(payload.target.rowId);
  }
  const targetMessageId = resolution.editTarget.transcriptMessageId;
  if (record.activeAbortController) {
    await preemptActiveTurnAndWait(host, record, {
      abortMessage: "v4 rewindConversation preempts active turn",
      goalPausedMutationReason: "rewind_conversation_goal_paused",
    });
  }
  // zcode-oss: Phase 3 —— 撤销点必须在任何副作用（文件恢复/分支切割）之前采集。
  let undoPoint: Awaited<ReturnType<typeof record.app.runtime.captureRewindUndoPoint>> = null;
  try {
    undoPoint = await record.app.runtime.captureRewindUndoPoint();
  } catch (error) {
    host.logger?.warn?.("rewind undo point capture failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  let filesRestored = false;
  // zcode-oss: Phase 2 —— rewind 模式先整树恢复工作区（覆盖 bash 等一切副作用），
  // 恢复成功才提交 conversation branch cut（与 editUserQuery 的"文件先行"失败语义一致）。
  if ((payload.workspaceMode ?? "preserve") === "rewind") {
    const restore = await record.app.runtime.restoreTurnStartWorkspaceSnapshot({
      targetMessageId: targetMessageId as MessageId,
      traceContext: record.traceContext,
    });
    if (!restore.restored) {
      // 非 git 工作区 / 该轮无快照（如历史版本产生的会话）没有可恢复的树
      // （Kilo 同语义：无 checkpoint 不挡对话回滚）。降级为 preserve 继续截断对话；
      // 其余失败维持 fail-closed（文件未动、对话不截断）。
      if (restore.reason !== "not_a_git_workspace" && restore.reason !== "snapshot_unavailable") {
        throw new V4RewindWorkspaceRestoreError(restore.reason ?? "git_failed", restore.message);
      }
      host.logger?.warn?.("rewind workspace restore degraded to preserve (not a git workspace)", {
        sessionId: record.app.sessionId,
        targetMessageId: String(targetMessageId),
      });
    } else {
      filesRestored = true;
    }
  }
  const result = await record.app.runtime.rewindConversationToMessage({
    events: [],
    targetMessageId: targetMessageId as MessageId,
    traceContext: record.traceContext,
  });
  if (result.strategy !== RewindStrategy.ActiveChain) {
    // D3：文件已恢复而对话未截断 = 半程状态。用撤销点捕获的 pre-undo 整树
    // 反向恢复文件（回滚的回滚），把工作区放回命令开始前的样子再抛错。
    if (filesRestored && undoPoint?.preRewindTreeHash) {
      try {
        await record.app.runtime.restoreWorkspaceTreeToHash(undoPoint.preRewindTreeHash);
      } catch (rollbackError) {
        host.logger?.warn?.("rewind file rollback after failed cut also failed", {
          message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          sessionId: record.app.sessionId,
        });
      }
    }
    throw new Error(`conversation rewind unavailable for ${targetMessageId}: ${result.strategy}`);
  }
  // zcode-oss: Phase 3 —— 落盘撤销点（失败只降级 redo，不影响本次 rewind）。
  if (undoPoint) {
    try {
      await record.app.runtime.commitRewindUndoPoint({
        filesRestored,
        point: undoPoint,
        postRewindActiveMessageCount: result.keptMessageCount,
        revertedRewindId: result.rewindId,
        targetMessageId: targetMessageId as MessageId,
      });
    } catch (error) {
      host.logger?.warn?.("rewind undo point commit failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // 与 editUserQuery 相同的过渡钩子：legacy 侧栏消费者感知；v4 投影走
  // RewindTriggered → row.removed 自收口。
  await host.afterLegacyStateMutation?.(record, "session_rewound");
  host.logger?.info?.("v4 rewindConversation completed", {
    ...traceContextToLogContext(record.traceContext),
    clientId: envelope.clientId,
    commandId: envelope.commandId,
    event: REWIND_CONVERSATION_COMPLETED_EVENT,
    module: CONVERSATION_COMMAND_LOG_MODULE,
    sessionId: record.app.sessionId,
    status: "completed",
    targetEntityId: payload.target.entityId,
    targetRowId: payload.target.rowId,
    workspaceMode: payload.workspaceMode ?? "preserve",
  });
  return undefined;
}

export const rewindConversationHandlers = { rewindConversation };
