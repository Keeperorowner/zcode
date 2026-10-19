// zcode-oss: message-rewind 无头 e2e 驱动（Node ≥20）
// 用法: node scripts/e2e-rewind.mjs <workspaceAbsPath>
// 流程: 2 轮写文件的对话 → 校验历史行 canRewind → rewindConversation 截断 → 校验 row.removed → 续跑一轮
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

const WS = process.argv[2];
let MODE = process.env.E2E_MODE === "preserve" ? "preserve" : "rewind";
// 非 git 工作区没有整树快照（agent 会降级为仅对话回滚，D2），文件断言跳过。
try {
  const { execSync } = await import("node:child_process");
  execSync("git rev-parse --is-inside-work-tree", { cwd: WS, stdio: "ignore" });
} catch {
  console.log("[e2e] 非 git 工作区：rewind 模式将降级为 preserve，跳过文件断言");
  MODE = "preserve";
}
const CLI = new URL("../apps/zcode-cli/packages/cli/dist/zcode.cjs", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const log = (...a) => console.log("[e2e]", ...a);

const proc = spawn(process.execPath, [CLI, "app-server", "--stdio"], {
  cwd: WS,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
let buf = "";
let nextId = 1;
const pending = new Map();
const frames = [];
const rows = new Map(); // rowId -> last row state
let removedEvents = [];

proc.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    try { appendFileSync(WS + "/frames.log", line.slice(0, 2000) + "\n"); } catch {}
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
      continue;
    }
    if (msg.method === "v4/conversation/frame" && msg.params) {
      const frame = msg.params.frame ?? msg.params;
      frames.push(frame);
      applyFrame(frame);
      continue;
    }
    // 服务端 → 客户端请求：必须应答，否则 createSession 等流程超时
    if (msg.method !== undefined && msg.id !== undefined) {
      if (msg.method === "session/requestRuntimePreferences") {
        proc.stdin.write(JSON.stringify({
          id: msg.id,
          result: {
            nativeSearchEnhancementsEnabled: true,
            memoryEnabled: false,
            askUserQuestionAutoResolutionEnabled: true,
            modelContextBudgetStrategy: "preflight-v1",
          },
        }) + "\n");
      } else if (msg.method === "interaction/requestPermission") {
        const opts = msg.params?.options?.map((o) => `${o.kind}/${o.name}`) ?? [];
        console.log("[e2e] 权限请求:", msg.params?.toolName ?? "?", JSON.stringify(opts), "→ allow");
        proc.stdin.write(JSON.stringify({ id: msg.id, result: { decision: "allow" } }) + "\n");
      } else {
        console.log("[e2e] 未知服务端请求，兜底空应答:", msg.method);
        proc.stdin.write(JSON.stringify({ id: msg.id, result: {} }) + "\n");
      }
    }
  }
});
proc.stderr.on("data", (c) => process.stderr.write("[agent] " + c));

function applyFrame(frame) {
  const payload = frame.payload ?? frame;
  if (payload.kind === "snapshot") {
    // zcode-oss Phase 3：redo 触发的投影 rehydrate 会推送全新快照——本地视图必须整体替换。
    rows.clear();
    removedEvents.length = 0;
    const snap = payload.snapshot ?? {};
    const windowRows = Array.isArray(snap.rows) ? snap.rows : (snap.rows?.window ?? []);
    for (const r of windowRows) rows.set(r.rowId, r);
    if (snap.logEpoch && logEpoch === undefined) logEpoch = snap.logEpoch;
  } else if (payload.kind === "deltas") {
    for (const d of payload.deltas ?? []) {
      if (d.op === "row.appended" || d.op === "row.upserted") rows.set(d.row.rowId, d.row);
      else if (d.op === "row.removed") {
        removedEvents.push(d);
        // 本地视图同步截断：删除 >= fromRowId 的所有行，等待逻辑才不会被陈旧行满足
        if (typeof d.fromRowId === "number") {
          for (const k of [...rows.keys()]) if (k >= d.fromRowId) rows.delete(k);
        }
      }
    }
  }
}

function request(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

function envelope(type, payload, extra = {}) {
  return {
    commandId: randomUUID(),
    clientId: "zcode-oss-e2e",
    sessionId: sessionId,
    issuedAt: Date.now(),
    type,
    payload,
    ...extra,
  };
}

let sessionId = null;
let logEpoch = undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTurnComplete(turnRowCount, timeoutMs = 240000) {
  // 等待：turnHeader 行数 >= turnRowCount 且全部非 running，且无 pendingInteractions
  const t0 = Date.now();
  for (;;) {
    const headers = [...rows.values()].filter((r) => r.kind === "turnHeader");
    const done = headers.length >= turnRowCount && headers.every((h) => h.state !== "running");
    if (done) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`turn#${turnRowCount} 等待超时；headers=${JSON.stringify(headers.map((h) => [h.rowId, h.state]))}`);
    await sleep(1500);
  }
}

try {
  log("workspace:", WS);
  // 1. 创建会话 + 首轮
  const create = await request("v4/command", {
    commandId: randomUUID(), clientId: "zcode-oss-e2e", sessionId: null, issuedAt: Date.now(),
    type: "createSession",
    payload: { workspaceId: WS, firstInput: { text: "Use the write tool to create a file named notes.txt with exactly the content: v1. Then reply with exactly: DONE1" } },
  });
  if (create.status !== "accepted") throw new Error("createSession 未 accepted: " + JSON.stringify(create));
  sessionId = create.result?.sessionId ?? create.sessionId;
  log("sessionId:", sessionId);

  // 2. 订阅帧
  const sub = await request("v4/conversation/subscribe", {
    topic: `conversation/${sessionId}`,
    connectionId: "zcode-oss-e2e-conn",
    clientMode: "desktop-continuous",
  });
  logEpoch = sub?.ack?.logEpoch ?? sub?.logEpoch;
  log("subscribed, logEpoch:", logEpoch);

  await waitTurnComplete(1);
  log("turn1 完成，notes.txt =", readFileSync(WS + "/notes.txt", "utf8").trim());

  // 3. 第二轮（bash 副作用：append v2 —— Phase 2 快照必须能覆盖的路径）
  const rev1 = await currentRevision();
  const send2 = await request("v4/command", envelope("sendText", { text: "Run this exact bash command in the workspace: printf 'v2\\n' >> notes.txt . Then reply with exactly: DONE2" }, { baseRevision: rev1 }));
  if (send2.status !== "accepted") throw new Error("sendText2 未 accepted: " + JSON.stringify(send2));
  await waitTurnComplete(2);
  log("turn2 完成，notes.txt =", JSON.stringify(readFileSync(WS + "/notes.txt", "utf8")));

  // 4. 找第一条 realUser 行（turn2 的），校验 canRewind 已下发（我的投影改动）
  const userRows = [...rows.values()].filter((r) => r.kind === "userInput" && r.origin === "realUser").sort((a, b) => a.rowId - b.rowId);
  if (userRows.length < 2) throw new Error("realUser 行不足 2 条: " + userRows.length);
  const target = userRows[1];
  log("目标行 rowId=", target.rowId, "entityId=", target.entityId, "actions=", JSON.stringify(target.actions));
  if (target.actions?.canRewind !== true) throw new Error("历史行未下发 canRewind（投影改动未生效）");
  const first = userRows[0];
  log("对照行(第1条) actions=", JSON.stringify(first.actions));

  // 5. 连撤两刀：先回滚到第 2 条 user 消息，再回滚到第 1 条（D1 多级场景）
  const firstRowRef = userRows[0];
  const rev2 = await currentRevision();
  const rewind1 = await request("v4/command", envelope("rewindConversation", { target: { rowId: target.rowId, entityId: target.entityId }, workspaceMode: MODE }, { baseRevision: rev2, baseLogEpoch: logEpoch }));
  log("rewind#1 ack:", JSON.stringify({ status: rewind1.status, reason: rewind1.reasonCode }));
  if (rewind1.status !== "accepted") throw new Error("rewind#1 未 accepted: " + JSON.stringify(rewind1));
  await sleep(1500);
  if (MODE === "rewind") {
    const f1 = readFileSync(WS + "/notes.txt", "utf8");
    if (f1.trim() !== "v1") throw new Error("rewind#1 后文件应回到 v1: " + JSON.stringify(f1));
    log("rewind#1(文件) ✓ notes.txt =", JSON.stringify(f1));
  }
  let visible = [...rows.values()].filter((r) => r.kind === "userInput" && r.origin === "realUser").length;
  if (visible !== 1) throw new Error(`rewind#1 后应剩 1 条 realUser 行，实际 ${visible}`);

  const rev2b = await currentRevision();
  const rewind2 = await request("v4/command", envelope("rewindConversation", { target: { rowId: firstRowRef.rowId, entityId: firstRowRef.entityId }, workspaceMode: MODE }, { baseRevision: rev2b, baseLogEpoch: logEpoch }));
  log("rewind#2 ack:", JSON.stringify({ status: rewind2.status, reason: rewind2.reasonCode }));
  if (rewind2.status !== "accepted") throw new Error("rewind#2 未 accepted: " + JSON.stringify(rewind2));
  await sleep(1500);
  visible = [...rows.values()].filter((r) => r.kind === "userInput" && r.origin === "realUser").length;
  if (visible !== 0) throw new Error(`rewind#2 后应剩 0 条 realUser 行，实际 ${visible}`);
  if (MODE === "rewind") {
    let gone = false;
    try { readFileSync(WS + "/notes.txt"); } catch { gone = true; }
    if (!gone) throw new Error("rewind#2 后 notes.txt 应被删除（回到 turn1 开始前）");
    log("rewind#2(文件) ✓ notes.txt 已回到 turn1 开始前（不存在）");
  }

  // 6. 连重做两刀（D1 回归测试：第二刀此前会被 stale_undo_entry 拒绝）
  const rev3 = await currentRevision();
  const redo1 = await request("v4/command", envelope("unrewindConversation", {}, { baseRevision: rev3 }));
  log("redo#1 ack:", JSON.stringify(redo1.status === "accepted" ? { status: redo1.status, result: redo1.result } : redo1));
  if (redo1.status !== "accepted") throw new Error("redo#1 未 accepted: " + JSON.stringify(redo1));
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if ([...rows.values()].some((r) => r.kind === "assistantText" && r.text.includes("DONE1"))) break;
      await sleep(1000);
    }
    visible = [...rows.values()].filter((r) => r.kind === "userInput" && r.origin === "realUser").length;
    if (visible !== 1) throw new Error(`redo#1 后应恢复到 1 条 realUser 行，实际 ${visible}`);
    if ((redo1.result?.entriesRemaining ?? 0) !== 1) throw new Error("redo#1 后 entriesRemaining 应为 1: " + JSON.stringify(redo1.result));
    if (MODE === "rewind") {
      const f = readFileSync(WS + "/notes.txt", "utf8");
      if (f.trim() !== "v1") throw new Error("redo#1 后文件应回到 v1: " + JSON.stringify(f));
    }
    log("redo#1 ✓（第一轮回归，栈剩 1）");
  }
  const rev4 = await currentRevision();
  const redo2 = await request("v4/command", envelope("unrewindConversation", {}, { baseRevision: rev4 }));
  log("redo#2 ack:", JSON.stringify(redo2.status === "accepted" ? { status: redo2.status, result: redo2.result } : redo2));
  if (redo2.status !== "accepted") throw new Error("redo#2 未 accepted（D1 回归失败！）: " + JSON.stringify(redo2));
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if ([...rows.values()].some((r) => r.kind === "assistantText" && r.text.includes("DONE2"))) break;
      await sleep(1000);
    }
    const texts = [...rows.values()].filter((r) => r.kind === "assistantText" && r.state === "complete").map((r) => r.text);
    if (!texts.some((t) => t.includes("DONE1")) || !texts.some((t) => t.includes("DONE2"))) throw new Error("redo#2 后两轮未全部回归: " + JSON.stringify(texts));
    if ((redo2.result?.entriesRemaining ?? 0) !== 0) throw new Error("redo#2 后 entriesRemaining 应为 0");
    if (MODE === "rewind") {
      const f = readFileSync(WS + "/notes.txt", "utf8");
      if (!f.includes("v2")) throw new Error("redo#2 后文件应回到 v1v2: " + JSON.stringify(f));
      log("redo#2(文件) ✓ notes.txt =", JSON.stringify(f));
    }
    log("redo#2 ✓（两轮全部回归，栈空）—— D1 多级重做回归通过");
  }

  // 7. redo 窗口语义：发新消息后 redo 必须被拒绝
  const rev5 = await currentRevision();
  const send3 = await request("v4/command", envelope("sendText", { text: "Reply with exactly: ALIVE" }, { baseRevision: rev5 }));
  if (send3.status !== "accepted") throw new Error("redo 后 sendText 未 accepted: " + JSON.stringify(send3));
  await sleep(1500);
  const rev6 = await currentRevision();
  const redo3 = await request("v4/command", envelope("unrewindConversation", {}, { baseRevision: rev6 }));
  log("新消息后的 redo ack:", JSON.stringify({ status: redo3.status, reasonCode: redo3.reasonCode }));
  if (redo3.status === "accepted") throw new Error("新消息后 redo 仍被接受（窗口未作废）");

  log("=== E2E 全部通过（多级 undo→redo 回归）===");
  proc.kill();
  process.exit(0);
} catch (e) {
  console.error("[e2e] 失败:", e.message);
  console.error("[e2e] rows:", JSON.stringify([...rows.values()].map((r) => [r.rowId, r.kind, r.state ?? "", r.origin ?? ""])));
  proc.kill();
  process.exit(1);
}

function currentRevision() {
  // 从最近的 state.updated delta / snapshot 取 revision
  for (let i = frames.length - 1; i >= 0; i--) {
    const payload = frames[i].payload ?? frames[i];
    if (payload.kind === "deltas") {
      for (const d of (payload.deltas ?? []).slice().reverse()) {
        if (d.op === "state.updated" && d.patch && typeof d.patch.revision === "number") return d.patch.revision;
      }
    } else if (payload.kind === "snapshot" && typeof payload.snapshot?.revision === "number") {
      return payload.snapshot.revision;
    }
  }
  return 0;
}
