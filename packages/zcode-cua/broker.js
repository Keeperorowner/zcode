import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";

/** 与 helper 侧 `src/broker/ipcVersion.ts` 对齐；不一致时 helper 直接回 version_mismatch。 */
export const CUA_BROKER_IPC_VERSION = 2;

const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_DEADLINE_MS = 5_000;
const DEFAULT_PROBE_POLL_MS = 150;
const DEFAULT_PROBE_PER_TRY_MS = 1_000;
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export class BrokerError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use broker is unavailable.");
    this.name = "BrokerError";
    this.code = options.code ?? "unavailable";
    if (options.details !== undefined) this.details = options.details;
  }
}

export class CuaHelperError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use Helper is unavailable.");
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper_unavailable";
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

const brokerErrorFactory = (code) => (message, details) =>
  new BrokerError(message ?? code, { code, details });

export const notAuthorized = brokerErrorFactory("not_authorized");
export const notSelectable = brokerErrorFactory("not_selectable");
export const notSettable = brokerErrorFactory("not_settable");
export const elementUnavailable = brokerErrorFactory("element_unavailable");
export const actionUnavailable = brokerErrorFactory("action_unavailable");
export const foregroundRequired = brokerErrorFactory("foreground_required");

/**
 * 协议层已知的方法名集合。
 *
 * 补齐原因：开源版把 `isBrokerMethod` 直接写成 `return false`，
 * 导致 `dispatchRequest` 对任何方法都回 method_not_found，broker 整条链路不可用。
 * 这里按 helper 的 `handleLineWithTimeout` 分派表 + 插件侧
 * `computer-use-client.mjs` 的 `COMPUTER_METHOD_NAMES` 并集登记，
 * 两侧任一新增工具必须同步，否则模型看得见工具却调不动。
 */
const READ_ONLY_METHODS = new Set([
  "ping",
  "broker_info",
  "list_apps",
  "list_windows",
  "get_app_state",
  "request_access",
  "query_permission_status",
  "query_screen_capture_probe",
  "query_screen_recording_preflight",
]);

const PIP_SESSION_METHODS = new Set([
  "pip_session_connect",
  "pip_session_send",
  "pip_session_close",
]);

const CONTROL_METHODS = new Set([
  "authenticate",
  "controller_takeover",
  "controller_stop",
  "capture",
  "terminal",
  "close",
]);

/** 会改变 UI 的工具方法；决定 possibly_sent 的判定路径（绝不重放）。 */
const MUTATING_METHODS = new Set([
  "left_click",
  "scroll",
  "left_click_drag",
  "type",
  "set_value",
  "select_text",
  "key",
  "perform_action",
  "paste",
  "stop_computer_control",
]);

const BROKER_METHODS = new Set([
  ...READ_ONLY_METHODS,
  ...PIP_SESSION_METHODS,
  ...CONTROL_METHODS,
  ...MUTATING_METHODS,
]);

export function isBrokerMethod(method) {
  return typeof method === "string" && BROKER_METHODS.has(method);
}

export function isReadOnlyBrokerMethod(method) {
  return typeof method === "string" && READ_ONLY_METHODS.has(method);
}

export function isPipSessionBrokerMethod(method) {
  return typeof method === "string" && PIP_SESSION_METHODS.has(method);
}

export function isMutatingBrokerMethod(method) {
  return typeof method === "string" && MUTATING_METHODS.has(method);
}

/**
 * 解析一行请求。
 *
 * 返回值是判别联合：成功 `{ok:true, request}`；失败 `{ok:false, id, code, message}`。
 * 开源版桩直接 `return undefined`，会让 helper 的
 * `enqueueLineDuringStop` / `handleLineWithTimeout` 全部走错误分支并把连接关掉。
 */
export function parseRequestLine(line) {
  if (typeof line !== "string") {
    return { ok: false, id: 0, code: "invalid_request", message: "request line must be a string" };
  }
  const trimmed = line.trim();
  if (!trimmed) {
    return { ok: false, id: 0, code: "invalid_request", message: "request line is empty" };
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_LINE_BYTES) {
    return {
      ok: false,
      id: 0,
      code: "invalid_request",
      message: `request line exceeds ${MAX_LINE_BYTES} bytes`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      id: 0,
      code: "invalid_request",
      message: error instanceof Error ? error.message : "request line is not valid JSON",
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, id: 0, code: "invalid_request", message: "request must be a JSON object" };
  }
  const id = normalizeId(parsed.id);
  if (typeof parsed.method !== "string" || !parsed.method.trim()) {
    return { ok: false, id, code: "invalid_request", message: "request.method must be a non-empty string" };
  }
  return {
    ok: true,
    request: {
      id,
      method: parsed.method.trim(),
      params: parsed.params,
    },
  };
}

function normalizeId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

export function okResponse(result, id) {
  return id === undefined ? { ok: true, result } : { ok: true, id, result };
}

export function errorResponse(message, options = {}) {
  // 兼容两种调用约定：开源 .d.ts 的 `errorResponse(message, {code})`，
  // 与 helper 内部的 `errorResponse(id, code, message)`。前者是对外契约，必须保留。
  if (typeof message === "number" || (typeof message === "string" && typeof options === "string")) {
    const id = message;
    const code = options;
    const text = arguments[2];
    return {
      ok: false,
      id,
      error: { message: String(text ?? code), code: String(code) },
    };
  }
  const code = options?.code;
  const id = options?.id;
  return {
    ok: false,
    ...(id !== undefined ? { id } : {}),
    error: { message: String(message), ...(code ? { code } : {}) },
  };
}

export function errorResponseFromException(error, id) {
  if (error instanceof BrokerError || error instanceof CuaHelperError) {
    return errorResponse(error.message, { code: error.code, ...(id !== undefined ? { id } : {}) });
  }
  const message = error instanceof Error ? error.message : String(error);
  return errorResponse(message, { code: "internal", ...(id !== undefined ? { id } : {}) });
}

export function serializeResponse(response) {
  return `${JSON.stringify(response)}\n`;
}

/**
 * 把请求派发给 backend（`method -> handler` 的映射）。
 *
 * 语义对齐 helper 侧 `dispatchRequest`：
 * 未知方法 / backend 未实现 → `method_not_found`；handler 抛错 → `internal` 或其自带 code；
 * 成功 → `{ok:true,id,result}`。handler 可返回 `{result, presentation}` 以附带 PiP 呈现信息。
 */
export async function dispatchRequest(backend, request) {
  const id = request?.id;
  if (!request || typeof request.method !== "string") {
    return errorResponse("request.method must be a string", { code: "invalid_request", id });
  }
  if (!isBrokerMethod(request.method)) {
    return errorResponse(`unknown broker method: ${request.method}`, {
      code: "method_not_found",
      id,
    });
  }
  const handler = backend?.[request.method];
  if (typeof handler !== "function") {
    return errorResponse(`broker backend does not implement: ${request.method}`, {
      code: "method_not_found",
      id,
    });
  }
  try {
    const result = await handler(request.params, { id, method: request.method });
    if (isBrokerPresentedResult(result)) {
      return okResponse(result.result, id, result.presentation);
    }
    return okResponse(result, id);
  } catch (error) {
    return errorResponseFromException(error, id);
  }
}

function isBrokerPresentedResult(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    "result" in value &&
    "presentation" in value &&
    !Array.isArray(value)
  );
}

export async function handleRequestLine(backend, line) {
  const parsed = parseRequestLine(line);
  if (!parsed.ok) {
    return errorResponse(parsed.message, { code: parsed.code, id: parsed.id });
  }
  return dispatchRequest(backend, parsed.request);
}

/**
 * 向 broker 发起一次方法调用：连接 socket → 写一行 JSON → 读一行响应。
 *
 * 补齐原因：开源版桩直接抛 `not available`，导致上层（helper host / 插件桥）
 * 拿不到任何 broker 能力。这里实现真正的 IPC 客户端半边。
 */
export async function callBrokerMethod({
  socketPath,
  method,
  params,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
}) {
  if (typeof socketPath !== "string" || !socketPath.trim()) {
    throw new CuaHelperError("socketPath is required", { code: "invalid_argument" });
  }
  const id = nextRequestId();
  const payload = serializeRequest({ id, method, params });

  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let buffer = "";
    let timer;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      fn(value);
    };

    const fail = (code, message) =>
      finish(reject, new CuaHelperError(message, { code }));

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(
        () => fail("timeout", `broker call ${method} timed out after ${timeoutMs}ms`),
        timeoutMs,
      );
    }

    socket.on("error", (error) => fail("connect_failed", error?.message ?? String(error)));
    socket.on("connect", () => {
      socket.write(payload, (error) => {
        if (error) fail("write_failed", error.message ?? String(error));
      });
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        fail("response_too_large", `broker response exceeds ${MAX_LINE_BYTES} bytes`);
        return;
      }
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        let response;
        try {
          response = JSON.parse(line);
        } catch (error) {
          fail("invalid_response", error instanceof Error ? error.message : "invalid JSON response");
          return;
        }
        if (!response || typeof response !== "object" || response.ok !== true) {
          const wireCode = response?.error?.code ?? "broker_error";
          const message = response?.error?.message ?? `broker method ${method} failed`;
          finish(reject, new BrokerError(message, { code: wireCode, details: response?.error?.details }));
          return;
        }
        finish(resolve, response.result);
        return;
      }
    });
    socket.on("end", () => fail("connection_closed", "broker closed the connection before responding"));
  });
}

let requestSeq = 0;
function nextRequestId() {
  requestSeq = (requestSeq + 1) % Number.MAX_SAFE_INTEGER;
  return requestSeq;
}

function serializeRequest(request) {
  return `${JSON.stringify({
    id: request.id,
    method: request.method,
    ...(request.params !== undefined ? { params: request.params } : {}),
  })}\n`;
}

/**
 * 探测 helper 存活：轮询 `broker_info` 直到成功或超时。
 *
 * 补齐原因：开源版桩返回 `{bundleId:null,pid:null}`，上层据此判定
 * 「helper 不可用」而拒绝启动 Computer Use。真实语义是发起一次轻量 RPC。
 */
export async function probeHelperHealth(socketPath, options = {}) {
  const deadlineMs = options.timeoutMs ?? DEFAULT_PROBE_DEADLINE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_PROBE_POLL_MS;
  const perTryTimeoutMs = options.perTryTimeoutMs ?? DEFAULT_PROBE_PER_TRY_MS;
  const startedAt = Date.now();

  for (;;) {
    try {
      const info = await callBrokerMethod({
        socketPath,
        method: "broker_info",
        params: { clientApiVersion: CUA_BROKER_IPC_VERSION },
        timeoutMs: perTryTimeoutMs,
      });
      return {
        bundleId: typeof info?.bundleId === "string" ? info.bundleId : (info?.bundle_id ?? null),
        pid: typeof info?.pid === "number" ? info.pid : null,
      };
    } catch (error) {
      if (Date.now() - startedAt >= deadlineMs) {
        // 超时后不抛错，返回空健康态：调用方据此走「未就绪」分支而不是崩溃。
        return { bundleId: null, pid: null, lastError: error instanceof Error ? error.message : String(error) };
      }
      await sleep(pollIntervalMs);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function mintBrokerSocketPath(options = {}) {
  const dir = typeof options.dir === "string" ? options.dir : tmpdir();
  return join(dir, `zcode-cua-broker-${randomUUID()}.sock`);
}

export function resolveBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env[BROKER_SOCKET_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  return mintBrokerSocketPath(options);
}
