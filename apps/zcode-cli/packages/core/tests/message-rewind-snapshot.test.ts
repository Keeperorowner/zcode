import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  captureTurnStartWorkspaceSnapshot,
  ensureShadowRepo,
  restoreWorkspaceTreeToHash,
  shadowRepoFor,
  writeCurrentTree,
} from "../src/runtime/methods/turn-workspace-snapshot.js";
import type { TurnWorkspaceSnapshotRestoreResult } from "../src/runtime/types.js";

// 这些用例要真实调用 git 子进程（影子仓的 write-tree / diff-tree / checkout-index），
// 因此断言的是「内容寻址的树恢复」这一实际行为，而不是 mock 出来的调用序列。

type SnapshotRuntime = {
  sessionId: string;
  workspaceRoot: string;
  logger?: { warn?: (message: string, meta?: unknown) => void };
};

const restoreTree = restoreWorkspaceTreeToHash as unknown as (
  this: SnapshotRuntime,
  treeHash: string,
) => Promise<TurnWorkspaceSnapshotRestoreResult>;

const captureSnapshot = captureTurnStartWorkspaceSnapshot as unknown as (
  this: SnapshotRuntime,
  options: { messageId: string; traceContext: unknown },
) => Promise<void>;

describe("turn workspace snapshot (shadow git)", () => {
  let root = "";
  let workspace = "";
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zcode-rewind-snapshot-"));
    // shadowRepoFor 落在 homedir() 下；把 home 重定向到临时目录，避免污染真实用户目录。
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

  it("shadowRepoFor 对同一工作区稳定、对不同工作区隔离", () => {
    const first = shadowRepoFor(workspace);
    const second = shadowRepoFor(path.join(workspace, "nested"));
    expect(first.gitDir).toBe(shadowRepoFor(workspace).gitDir);
    expect(first.gitDir).not.toBe(second.gitDir);
    expect(first.workspaceRoot).toBe(path.resolve(workspace));
    expect(path.isAbsolute(first.gitDir)).toBe(true);
  });

  it("ensureShadowRepo 在非 git 工作区返回 false", async () => {
    const repo = shadowRepoFor(workspace);
    expect(await ensureShadowRepo(repo)).toBe(false);
  });

  it("ensureShadowRepo 在 git 工作区建立影子仓", async () => {
    initGitRepo(workspace);
    const repo = shadowRepoFor(workspace);
    expect(await ensureShadowRepo(repo)).toBe(true);
    // 影子仓是独立 bare 仓：不复用用户仓库的 .git。
    expect(await exists(path.join(repo.gitDir, "HEAD"))).toBe(true);
    expect(await exists(path.join(workspace, ".git"))).toBe(true);
  });

  it("writeCurrentTree 是内容寻址的：内容相同则树哈希相同", async () => {
    initGitRepo(workspace);
    await writeFile(path.join(workspace, "a.txt"), "hello", "utf8");
    const repo = shadowRepoFor(workspace);
    expect(await ensureShadowRepo(repo)).toBe(true);
    const first = await writeCurrentTree(repo, "test-1");
    const second = await writeCurrentTree(repo, "test-2");
    expect(first).toBeTruthy();
    expect(first).toBe(second);
    await writeFile(path.join(workspace, "a.txt"), "changed", "utf8");
    const third = await writeCurrentTree(repo, "test-3");
    expect(third).not.toBe(first);
  });

  it("writeCurrentTree 在非 git 工作区不产生树", async () => {
    const repo = shadowRepoFor(workspace);
    await writeFile(path.join(workspace, "a.txt"), "hello", "utf8");
    expect(await writeCurrentTree(repo, "test-nogit")).toBeNull();
  });

  it("restoreWorkspaceTreeToHash 在非 git 工作区 fail-closed", async () => {
    const result = await restoreTree.call({ sessionId: "s1", workspaceRoot: workspace }, "0" as string);
    expect(result.restored).toBe(false);
    expect(result.reason).toBe("not_a_git_workspace");
  });

  it("restoreWorkspaceTreeToHash 还原被修改的文件、删除新建的文件、恢复被删的文件", async () => {
    initGitRepo(workspace);
    await writeFile(path.join(workspace, "keep.txt"), "original", "utf8");
    await writeFile(path.join(workspace, "removed.txt"), "will-be-deleted", "utf8");

    const repo = shadowRepoFor(workspace);
    expect(await ensureShadowRepo(repo)).toBe(true);
    const snapshot = await writeCurrentTree(repo, "snapshot");
    expect(snapshot).toBeTruthy();

    // 快照之后：修改一个文件、删掉一个文件、新建一个文件。
    await writeFile(path.join(workspace, "keep.txt"), "mutated", "utf8");
    await rm(path.join(workspace, "removed.txt"));
    await writeFile(path.join(workspace, "created.txt"), "brand-new", "utf8");

    const result = await restoreTree.call({ sessionId: "s1", workspaceRoot: workspace }, snapshot!);
    expect(result.restored).toBe(true);
    expect(result.files).toBeGreaterThan(0);

    expect(await readFile(path.join(workspace, "keep.txt"), "utf8")).toBe("original");
    expect(await readFile(path.join(workspace, "removed.txt"), "utf8")).toBe("will-be-deleted");
    expect(await exists(path.join(workspace, "created.txt"))).toBe(false);
  });

  it("captureTurnStartWorkspaceSnapshot 落一条可回溯的影子仓 ref", async () => {
    initGitRepo(workspace);
    await writeFile(path.join(workspace, "a.txt"), "v1", "utf8");
    const runtime: SnapshotRuntime = { sessionId: "session-1", workspaceRoot: workspace };
    await captureSnapshot.call(runtime, { messageId: "msg-1", traceContext: {} });

    const repo = shadowRepoFor(workspace);
    const ref = `refs/zcode-oss/turnsnap/session-1/msg-1`;
    const tree = execFileSync("git", ["--git-dir", repo.gitDir, "rev-parse", ref], {
      encoding: "utf8",
    }).trim();
    expect(tree).toBeTruthy();

    // 快照之后改动工作区，再按该 ref 恢复，内容应回到快照时刻。
    await writeFile(path.join(workspace, "a.txt"), "v2", "utf8");
    const result = await restoreTree.call(runtime, tree);
    expect(result.restored).toBe(true);
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("v1");
  });
});

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "zcode-test"], { cwd: dir });
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
