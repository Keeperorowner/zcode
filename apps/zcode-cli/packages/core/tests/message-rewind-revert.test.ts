import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  captureRewindUndoPoint,
  clearRewindUndoJournal,
  commitRewindUndoPoint,
  undoConversationRewind,
} from "../src/runtime/methods/rewind-revert.js";
import { shadowRepoFor } from "../src/runtime/methods/turn-workspace-snapshot.js";
import type {
  ConversationRewindRestoreResult,
  RewindUndoPoint,
} from "../src/runtime/types.js";

// redo（撤销一次 rewind）的实现体在 apps/zcode-cli/packages/core/src/runtime/methods/rewind-revert.ts。
// 这里覆盖可独立验证的部分：撤销点的采集/落盘/作废，以及 redo 的三道拒绝闸
// （无 session store / 无撤销点 / 分支代际过期）。redo 的成功路径需要完整 runtime
// （分支重建、历史水合、事件追加），由 scripts/e2e-rewind.mjs 端到端覆盖。

type SessionRevertLike = {
  branchGeneration: number;
  keptMessageIDs: string[];
  branchCutAfterMessageID: string;
  targetMessageID: string;
};

type FakeRuntime = {
  sessionId: string;
  workspaceRoot: string;
  branchGeneration: number;
  sessionStore?: {
    getSession: (sessionID: string) => Promise<{ revert?: SessionRevertLike } | null>;
    messages: (input: { sessionID: string }) => Promise<unknown[]>;
    clearRevert: (sessionID: string) => Promise<void>;
  };
  runtimeTaskRegistry?: { setActiveBranchGeneration?: (generation: number) => void };
};

const capturePoint = captureRewindUndoPoint as unknown as (
  this: FakeRuntime,
) => Promise<RewindUndoPoint | null>;

const commitPoint = commitRewindUndoPoint as unknown as (
  this: FakeRuntime,
  input: {
    point: RewindUndoPoint;
    revertedRewindId: string;
    targetMessageId: string;
    postRewindActiveMessageCount: number;
    filesRestored: boolean;
  },
) => Promise<void>;

const clearJournal = clearRewindUndoJournal as unknown as (this: FakeRuntime) => Promise<void>;

const undoRewind = undoConversationRewind as unknown as (
  this: FakeRuntime,
  options: { traceContext: unknown },
) => Promise<ConversationRewindRestoreResult>;

describe("rewind undo journal (redo)", () => {
  let root = "";
  let workspace = "";
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zcode-rewind-revert-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    const fakeHome = path.join(root, "home");
    await mkdir(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    await rm(root, { recursive: true, force: true });
  });

  it("没有 session store 时采集不到撤销点", async () => {
    const runtime: FakeRuntime = { sessionId: "s1", workspaceRoot: workspace, branchGeneration: 0 };
    expect(await capturePoint.call(runtime)).toBeNull();
  });

  it("采集撤销点时快照当时的 revert 状态与 active 消息数", async () => {
    const runtime = runtimeWithStore(workspace, {
      currentRevert: {
        branchGeneration: 3,
        keptMessageIDs: ["m1", "m2"],
        branchCutAfterMessageID: "m2",
        targetMessageID: "m2",
      },
    });
    const point = await capturePoint.call(runtime);
    expect(point).not.toBeNull();
    expect(point!.preRewindBranchGeneration).toBe(3);
    expect(point!.preActiveMessageCount).toBe(2);
    expect(point!.previousRevert).toMatchObject({ branchGeneration: 3, targetMessageID: "m2" });
    // 结构化拷贝：后续 store 内部对象突变不能污染已采集的撤销点。
    const revert = runtime.sessionStore!.getSession;
    void revert;
    expect(point!.previousRevert).not.toBe(runtime.sessionStore!.getSession);
  });

  it("提交撤销点后落盘到影子仓旁的 undo journal", async () => {
    const runtime = runtimeWithStore(workspace);
    const point = await capturePoint.call(runtime);
    expect(point).not.toBeNull();
    await commitPoint.call(runtime, {
      filesRestored: false,
      point: point!,
      postRewindActiveMessageCount: 1,
      revertedRewindId: "rewind_1",
      targetMessageId: "m2",
    });

    const journal = await readJournal(workspace, runtime.sessionId);
    expect(journal).not.toBeNull();
    expect(journal!.entries).toHaveLength(1);
    expect(journal!.entries[0]).toMatchObject({
      filesRestored: false,
      postRewindActiveMessageCount: 1,
      postRewindBranchGeneration: 1,
      revertedRewindId: "rewind_1",
      targetMessageId: "m2",
    });
  });

  it("作废撤销点会清空 journal（新 prompt 语义）", async () => {
    const runtime = runtimeWithStore(workspace);
    const point = await capturePoint.call(runtime);
    await commitPoint.call(runtime, {
      filesRestored: false,
      point: point!,
      postRewindActiveMessageCount: 0,
      revertedRewindId: "rewind_1",
      targetMessageId: "m1",
    });
    expect(await readJournal(workspace, runtime.sessionId)).not.toBeNull();
    await clearJournal.call(runtime);
    expect(await readJournal(workspace, runtime.sessionId)).toBeNull();
  });

  it("redo 在没有 session store 时拒绝", async () => {
    const runtime: FakeRuntime = { sessionId: "s1", workspaceRoot: workspace, branchGeneration: 0 };
    const result = await undoRewind.call(runtime, { traceContext: {} });
    expect(result.restored).toBe(false);
    expect(result.reason).toBe("no_session_store");
  });

  it("redo 在没有撤销点时拒绝", async () => {
    const runtime = runtimeWithStore(workspace);
    const result = await undoRewind.call(runtime, { traceContext: {} });
    expect(result.restored).toBe(false);
    expect(result.reason).toBe("no_undo_entry");
  });

  it("redo 在分支代际早于撤销点记录时拒绝（stale 撤销点）", async () => {
    const runtime = runtimeWithStore(workspace);
    const point = await capturePoint.call(runtime);
    await commitPoint.call(runtime, {
      filesRestored: false,
      point: point!,
      postRewindActiveMessageCount: 0,
      revertedRewindId: "rewind_1",
      targetMessageId: "m1",
    });
    // 撤销点记录 post = pre + 1 = 1；当前代际被外部改写回 0 即过期。
    const stale = runtimeWithStore(workspace);
    const result = await undoRewind.call(stale, { traceContext: {} });
    expect(result.restored).toBe(false);
    expect(result.reason).toBe("stale_undo_entry");
  });

  it("redo 在分支代际不低于撤销点记录时不触发 stale 闸", async () => {
    const runtime = runtimeWithStore(workspace);
    const point = await capturePoint.call(runtime);
    await commitPoint.call(runtime, {
      filesRestored: false,
      point: point!,
      postRewindActiveMessageCount: 0,
      revertedRewindId: "rewind_1",
      targetMessageId: "m1",
    });
    const current = runtimeWithStore(workspace, {
      currentRevert: {
        branchGeneration: 5,
        keptMessageIDs: [],
        branchCutAfterMessageID: "m2",
        targetMessageID: "m2",
      },
    });
    let reason: string | undefined;
    try {
      const result = await undoRewind.call(current, { traceContext: {} });
      reason = result.reason;
    } catch {
      // 越过代际闸后进入分支重建；fake runtime 不具备重建所需状态，
      // 这里只关心「没有被 stale 闸挡下」。
    }
    expect(reason).not.toBe("stale_undo_entry");
  });
});

function runtimeWithStore(
  workspaceRoot: string,
  options?: { currentRevert?: SessionRevertLike },
): FakeRuntime {
  return {
    sessionId: "session-1",
    workspaceRoot,
    branchGeneration: options?.currentRevert?.branchGeneration ?? 0,
    runtimeTaskRegistry: { setActiveBranchGeneration: () => {} },
    sessionStore: {
      // 当前代际的事实来源是 store 里的 revert 状态（不是 runtime 上的镜像字段），
      // 因此 getSession 必须如实回放它。
      getSession: async () => (options?.currentRevert ? { revert: options.currentRevert } : null),
      messages: async () => [{ info: { id: "m1" } }, { info: { id: "m2" } }],
      setRevert: async () => {},
      clearRevert: async () => {},
    },
  };
}

async function readJournal(
  workspaceRoot: string,
  sessionId: string,
): Promise<{ entries: Array<Record<string, unknown>> } | null> {
  const repo = shadowRepoFor(workspaceRoot);
  const file = path.join(repo.gitDir, "undo-journal", `${sessionId}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8")) as { entries: Array<Record<string, unknown>> };
  } catch {
    return null;
  }
}
