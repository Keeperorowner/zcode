// zcode-oss: message-rewind Phase 3 —— unrewindConversation（redo：撤销的后悔药）。
// 语义：恢复最近一次 rewindConversation 的全部效果（被截断的消息分支、撤销时的文件
// 回滚），相当于该次撤销从未发生。窗口约束（Kilo 同款）：新 prompt 开始即作废撤销点。
// 投影刷新：core 恢复分支 + 落 RewindReverted 事件后，强制投影 rehydrate——
// 订阅者 resync 收到完整分支的全新快照，被截断的消息行全部回归。
import type { CommandEnvelope, CommandResult } from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { preemptActiveTurnAndWait } from "./session-flow.js";

const REWIND_RESTORE_COMPLETED_EVENT = "conversation.command.unrewind_conversation.completed";

/** 撤销点不存在 / 已因新消息作废 / 分支代际不匹配。 */
class V4UnrewindUnavailableError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "V4UnrewindUnavailableError";
  }
}

async function unrewindConversation(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (record.activeAbortController) {
    await preemptActiveTurnAndWait(host, record, {
      abortMessage: "v4 unrewindConversation preempts active turn",
      goalPausedMutationReason: "unrewind_conversation_goal_paused",
    });
  }
  const result = await record.app.runtime.undoConversationRewind({
    traceContext: record.traceContext,
  });
  if (!result.restored) {
    const reasonCode = `guard.unrewindUnavailable.${result.reason ?? "unknown"}`;
    throw new V4UnrewindUnavailableError(
      reasonCode,
      `unrewindConversation 不可用: ${result.reason ?? "unknown"}${result.message ? ` (${result.message})` : ""}`,
    );
  }
  // 分支已恢复；投影从持久事实重建（抑制被撤销的 RewindTriggered），
  // 订阅者经 resync 收到完整分支快照。
  await host.forceConversationProjectionRehydrate?.(record.app.sessionId);
  await host.afterLegacyStateMutation?.(record, "session_unrewound");
  host.logger?.info?.("v4 unrewindConversation completed", {
    clientId: envelope.clientId,
    commandId: envelope.commandId,
    event: REWIND_RESTORE_COMPLETED_EVENT,
    filesRestored: result.filesRestored ?? 0,
    module: "bootstrap.zcode_protocol_v4.commands",
    restoredMessageCount: result.restoredMessageCount ?? 0,
    sessionId: record.app.sessionId,
    status: "completed",
  });
  return {
    type: "unrewindConversation",
    entriesRemaining: result.entriesRemaining ?? 0,
    filesRestored: result.filesRestored ?? 0,
    restoredMessageCount: result.restoredMessageCount ?? 0,
  };
}

export const unrewindConversationHandlers = { unrewindConversation };
