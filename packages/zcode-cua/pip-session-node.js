import { createConnection } from "node:net";
import {
  BrokerError,
  parseRequestLine,
  serializeResponse,
  okResponse,
} from "./broker.js";

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * PiP（画中画）会话事件客户端。
 *
 * 补齐原因：开源版桩恒 `enabled:false` 且 `send` 永远 `{applied:false}`，
 * 导致 PiP 呈现侧收不到任何 turn/focus 事件，画中画窗口的回合指示与焦点跟随全废。
 * 这里实现真正的客户端半边：连上 helper 的 PiP 控制端口，按行发事件、收 ack。
 */
export function createPipSessionClient(options = {}) {
  const socketPath = typeof options.socketPath === "string" ? options.socketPath.trim() : "";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reconnectAttempts = options.reconnectAttempts ?? 0;
  const reconnectDelayMs = options.reconnectDelayMs ?? 250;
  const peerChecker = typeof options.peerChecker === "function" ? options.peerChecker : undefined;
  const onDiagnostic = typeof options.onDiagnostic === "function" ? options.onDiagnostic : undefined;

  let socket = null;
  let connecting = null;
  let sequence = 0;

  const diagnose = (code, message) => {
    try {
      onDiagnostic?.({ code, message });
    } catch {
      // 诊断回调抛错不能影响会话事件发送。
    }
  };

  const enabled = Boolean(socketPath);

  const connectOnce = () =>
    new Promise((resolve, reject) => {
      const conn = createConnection(socketPath);
      let settled = false;
      const fail = (code, message) => {
        if (settled) return;
        settled = true;
        conn.destroy();
        diagnose(code, message);
        reject(new BrokerError(message, { code }));
      };
      conn.on("error", (error) => fail("pip_connect_failed", error?.message ?? String(error)));
      conn.on("connect", () => {
        if (peerChecker && !peerChecker(conn)) {
          fail("pip_peer_rejected", "PiP session peer check rejected the connection");
          return;
        }
        if (settled) return;
        settled = true;
        socket = conn;
        conn.on("error", (error) => diagnose("pip_socket_error", error?.message ?? String(error)));
        conn.on("close", () => {
          if (socket === conn) socket = null;
        });
        resolve();
      });
    });

  const connect = async () => {
    if (!enabled) {
      diagnose("pip_disabled", "PiP session client is disabled: no socketPath");
      return;
    }
    if (socket) return;
    if (connecting) return await connecting;
    let lastError;
    for (let attempt = 0; attempt <= reconnectAttempts; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
      }
      connecting = connectOnce();
      try {
        await connecting;
        connecting = null;
        return;
      } catch (error) {
        connecting = null;
        lastError = error;
      }
    }
    throw lastError ?? new BrokerError("PiP session connect failed", { code: "pip_connect_failed" });
  };

  const send = async (event) => {
    if (!enabled) return { applied: false, reason: "disabled" };
    if (!event || typeof event !== "object") return { applied: false, reason: "invalid_event" };
    try {
      if (!socket) await connect();
    } catch (error) {
      return { applied: false, reason: error instanceof Error ? error.message : String(error) };
    }
    const conn = socket;
    if (!conn) return { applied: false, reason: "not_connected" };

    sequence += 1;
    const payload = serializeResponse(
      okResponse({ ...event, sequenceNumber: event.sequenceNumber ?? sequence }),
    );

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        conn.off("data", onData);
        resolve(value);
      };
      let buffer = "";
      const onData = (chunk) => {
        buffer += chunk.toString("utf8");
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) return;
        const line = buffer.slice(0, newlineIndex);
        try {
          const parsed = JSON.parse(line);
          finish(parsed?.ok === true ? { applied: true } : { applied: false, reason: parsed?.error?.message });
        } catch {
          finish({ applied: false, reason: "invalid ack" });
        }
      };
      const timer = setTimeout(() => finish({ applied: false, reason: "timeout" }), timeoutMs);
      conn.on("data", onData);
      // PiP 事件是单向通知：多数实现不回 ack。写成功即视为已下发，
      // 读到 ack 则以其结果为准（幂等，避免写成功与 ack 双计）。
      conn.write(payload, (error) => {
        if (error) {
          finish({ applied: false, reason: error.message ?? String(error) });
          return;
        }
        setTimeout(() => finish({ applied: true }), 0);
      });
    });
  };

  const close = () => {
    const conn = socket;
    socket = null;
    try {
      conn?.end();
      conn?.destroy();
    } catch {
      // 关闭失败忽略：socket 可能已被对端关掉。
    }
  };

  return { enabled, connect, send, close };
}

export { parseRequestLine };
