// zcode-oss: message-rewind Phase 2 —— turn 起点全量快照（shadow git）。
/* oxlint-disable eslint(max-lines) -- 快照捕获/整树恢复/树 diff 应用是同一影子仓关注点，
   拆文件会散落 GIT_INDEX_FILE 约定与路径安全防御；对齐上游 ConversationRowView 的豁免惯例。 */
// 语义：每个真实用户轮开始（用户消息持久化后、任何工具执行前）对整个工作区拍
// content-addressed 快照（临时 index `git add -A` + `write-tree`），关联关系存进影子仓
// 自身的 `refs/zcode-oss/turnsnap/<sessionId>/<messageId>`——自描述、跨重启，且不进
// CheckpointCreated 事件流（避免污染既有 edit/retry 的 per-file 级联预检）。
// 回滚：diff 目标树与当前树，逐文件恢复 + 删除快照后新建的文件，覆盖 bash 等
// 一切文件副作用。非 git 工作区 / git 缺失：capture 静默跳过，restore fail-closed。
// 参照：Kilo Code snapshot（packages/opencode/src/snapshot/index.ts）与上游
// services 侧 gitCheckpointRepo 的临时 index + hidden ref 方案。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { traceContextToLogContext } from "../deps.js";
import type { MessageId, TraceContext } from "../deps.js";
import type { TurnWorkspaceSnapshotRestoreResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

const SNAPSHOT_REFS_PREFIX = "refs/zcode-oss/turnsnap";

function runGit(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> },
): Promise<{ ok: true; stdout: string } | { ok: false; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      args,
      options.cwd ? { cwd: options.cwd, env: { ...process.env, ...options.env } } : undefined,
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => resolve({ ok: false, stderr: String(error) }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, stdout });
      else resolve({ ok: false, stderr: stderr || `git exit ${code}` });
    });
  });
}

export interface ShadowRepo {
  gitDir: string;
  workspaceRoot: string;
}

export function shadowRepoFor(workspaceRoot: string): ShadowRepo {
  const key = createHash("sha1").update(path.resolve(workspaceRoot).toLowerCase()).digest("hex");
  return {
    gitDir: path.join(homedir(), ".zcode", "cli", "snapshots", key),
    workspaceRoot: path.resolve(workspaceRoot),
  };
}

export async function ensureShadowRepo(repo: ShadowRepo): Promise<boolean> {
  // 工作区本身必须是 git 仓库（Kilo 同语义）：ignore 规则与安全性都依赖它。
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: repo.workspaceRoot });
  if (!inside.ok || inside.stdout.trim() !== "true") return false;
  if (!existsSync(path.join(repo.gitDir, "HEAD"))) {
    await mkdir(repo.gitDir, { recursive: true });
    const init = await runGit(["init", "--bare", "--quiet", repo.gitDir], { cwd: repo.workspaceRoot });
    if (!init.ok) return false;
    await runGit(["--git-dir", repo.gitDir, "config", "core.autocrlf", "false"], {
      cwd: repo.workspaceRoot,
    });
  }
  return true;
}

/** 临时 index 全量入树：`add -A` + `write-tree`，返回 tree hash（内容寻址）。 */
export async function writeCurrentTree(repo: ShadowRepo, scratchTag: string): Promise<string | null> {
  const indexFile = path.join(repo.gitDir, `index-${scratchTag}`);
  const env = { GIT_INDEX_FILE: indexFile };
  const base = ["--git-dir", repo.gitDir, "--work-tree", repo.workspaceRoot];
  const add = await runGit([...base, "add", "-A", "--", "."], { cwd: repo.workspaceRoot, env });
  if (!add.ok) {
    await rm(indexFile, { force: true });
    return null;
  }
  const tree = await runGit([...base, "write-tree"], { cwd: repo.workspaceRoot, env });
  await rm(indexFile, { force: true });
  return tree.ok ? tree.stdout.trim() : null;
}

/**
 * turn 起点快照：用户消息持久化后、任何工具执行前调用。
 * 任何失败只 warn 不抛——快照是回滚增强，不能阻塞正常 turn。
 */
export async function captureTurnStartWorkspaceSnapshot(
  this: AgentRuntimeInternal,
  options: {
    messageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<void> {
  try {
    const repo = shadowRepoFor(this.workspaceRoot);
    if (!(await ensureShadowRepo(repo))) return;
    const tree = await writeCurrentTree(repo, `cap-${this.sessionId}`);
    if (!tree) return;
    const ref = `${SNAPSHOT_REFS_PREFIX}/${this.sessionId}/${options.messageId}`;
    const update = await runGit(["--git-dir", repo.gitDir, "update-ref", ref, tree], {
      cwd: repo.workspaceRoot,
    });
    if (!update.ok) {
      this.logger?.warn?.("zcode-oss turn snapshot ref update failed", {
        ...traceContextToLogContext(options.traceContext),
        event: "turn_snapshot.ref_update_failed",
        module: "core.runtime.turn_workspace_snapshot",
        ref,
      });
    }
  } catch (error) {
    this.logger?.warn?.("zcode-oss turn snapshot capture failed", {
      event: "turn_snapshot.capture_failed",
      module: "core.runtime.turn_workspace_snapshot",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 恢复到目标 turn 起点的工作区状态（整树 diff 恢复）：
 * - 快照后新建的文件（A）→ 删除
 * - 快照后被修改的文件（M）→ 从快照树恢复
 * - 快照后用户删除的文件（D）→ 从快照树恢复
 * 与快照内容一致的文件不触碰。文件恢复成功后由调用方提交 conversation branch cut。
 */
export async function restoreTurnStartWorkspaceSnapshot(
  this: AgentRuntimeInternal,
  options: {
    targetMessageId: MessageId;
    traceContext?: TraceContext;
  },
): Promise<TurnWorkspaceSnapshotRestoreResult> {
  const repo = shadowRepoFor(this.workspaceRoot);
  if (!(await ensureShadowRepo(repo))) {
    return { restored: false, reason: "not_a_git_workspace" };
  }
  const ref = `${SNAPSHOT_REFS_PREFIX}/${this.sessionId}/${options.targetMessageId}`;
  const target = await runGit(["--git-dir", repo.gitDir, "rev-parse", ref], {
    cwd: repo.workspaceRoot,
  });
  if (!target.ok) {
    return { restored: false, reason: "snapshot_unavailable", message: target.stderr.slice(0, 200) };
  }
  const targetTree = target.stdout.trim();
  const currentTree = await writeCurrentTree(repo, `res-${this.sessionId}`);
  if (!currentTree) {
    return { restored: false, reason: "git_failed", message: "write-tree failed" };
  }
  if (targetTree === currentTree) {
    return { restored: true, files: 0 };
  }
  const applied = await applyTreeDiffToWorktree(repo, targetTree, currentTree, this.sessionId);
  if (!applied.ok) {
    return { restored: false, reason: "git_failed", message: applied.message };
  }
  const files = applied.files;
  this.logger?.info?.("zcode-oss turn snapshot restored", {
    ...(options.traceContext ? traceContextToLogContext(options.traceContext) : {}),
    event: "turn_snapshot.restored",
    module: "core.runtime.turn_workspace_snapshot",
    sessionId: this.sessionId,
    targetMessageId: options.targetMessageId,
    files,
  });
  return { restored: true, files };
}

/**
 * zcode-oss: Phase 3 —— 把工作区整树恢复到任意 tree hash（redo 用）。
 * 语义与 restoreTurnStartWorkspaceSnapshot 相同：A→删除、M/D→恢复。
 */
export async function restoreWorkspaceTreeToHash(
  this: AgentRuntimeInternal,
  treeHash: string,
): Promise<TurnWorkspaceSnapshotRestoreResult> {
  const repo = shadowRepoFor(this.workspaceRoot);
  if (!(await ensureShadowRepo(repo))) {
    return { restored: false, reason: "not_a_git_workspace" };
  }
  const currentTree = await writeCurrentTree(repo, `redo-${this.sessionId}`);
  if (!currentTree) {
    return { restored: false, reason: "git_failed", message: "write-tree failed" };
  }
  if (treeHash === currentTree) {
    return { restored: true, files: 0 };
  }
  const applied = await applyTreeDiffToWorktree(repo, treeHash, currentTree, this.sessionId);
  if (!applied.ok) {
    return { restored: false, reason: "git_failed", message: applied.message };
  }
  return { restored: true, files: applied.files };
}

/** diff 目标树与当前树并把差异应用到工作区：A→删除、M/D→从目标树恢复。 */
async function applyTreeDiffToWorktree(
  repo: ShadowRepo,
  targetTree: string,
  currentTree: string,
  scratchTag: string,
): Promise<{ ok: true; files: number } | { ok: false; message: string }> {
  const diff = await runGit(
    ["--git-dir", repo.gitDir, "diff-tree", "-r", "--no-renames", "--name-status", "-z", targetTree, currentTree],
    { cwd: repo.workspaceRoot },
  );
  if (!diff.ok) {
    return { ok: false, message: diff.stderr.slice(0, 200) };
  }
  const parts = diff.stdout.split(" ").filter((item) => item.length > 0);
  const toRestore: string[] = [];
  const toDelete: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]![0];
    const relPath = parts[i + 1]!;
    const abs = path.resolve(repo.workspaceRoot, relPath);
    if (!abs.startsWith(repo.workspaceRoot + path.sep) && abs !== repo.workspaceRoot) continue;
    if (status === "A") toDelete.push(abs);
    else toRestore.push(abs);
  }
  let files = 0;
  if (toRestore.length > 0) {
    const indexFile = path.join(repo.gitDir, `index-restore-${scratchTag}`);
    const env = { GIT_INDEX_FILE: indexFile };
    const base = ["--git-dir", repo.gitDir, "--work-tree", repo.workspaceRoot];
    const readTree = await runGit([...base, "read-tree", targetTree], { cwd: repo.workspaceRoot, env });
    if (!readTree.ok) {
      await rm(indexFile, { force: true });
      return { ok: false, message: readTree.stderr.slice(0, 200) };
    }
    for (let i = 0; i < toRestore.length; i += 64) {
      const batch = toRestore.slice(i, i + 64);
      const checkout = await runGit(
        [...base, "checkout-index", "-f", "--", ...batch.map((item) => path.relative(repo.workspaceRoot, item))],
        { cwd: repo.workspaceRoot, env },
      );
      if (!checkout.ok) {
        await rm(indexFile, { force: true });
        return { ok: false, message: checkout.stderr.slice(0, 200) };
      }
      files += batch.length;
    }
    await rm(indexFile, { force: true });
  }
  for (const abs of toDelete) {
    try {
      await unlink(abs);
      files += 1;
    } catch {
      // 已被并发删除：不视为失败。
    }
  }
  return { ok: true, files };
}
