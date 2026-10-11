import {
  BrokerError,
  CUA_BROKER_IPC_VERSION,
  CuaHelperError,
  callBrokerMethod,
  isMutatingBrokerMethod,
  probeHelperHealth,
  resolveBrokerSocketPath,
} from "./broker.js";

/**
 * Computer Use 运行时入口。
 *
 * 补齐原因：开源版 `index.js` 只有一句 `Computer Use is not available in this build.`，
 * 且官方二进制 asar 全文检索**没有**这句桩字符串（说明官方是真实现、开源是抽空的桩）。
 * 这里按 `index.d.ts` 的 `ComputerUseRuntime` 契约 + 插件侧
 * `zcode-cua-plugin/scripts/computer-use-client.mjs` 的工具名清单实现真正的工具派发。
 */

/** 与 producer 侧 `zcode-cua/src/tools/manifest.ts` 的工具面一致；两侧必须同步。 */
const COMPUTER_METHOD_NAMES = Object.freeze([
  "list_apps",
  "list_windows",
  "get_app_state",
  "left_click",
  "scroll",
  "left_click_drag",
  "type",
  "set_value",
  "select_text",
  "key",
  "perform_action",
  "paste",
  "request_access",
  "stop_computer_control",
]);

const ERROR_CODE_BY_BROKER = Object.freeze({
  permission_denied: "PERMISSION_DENIED",
  not_authorized: "NOT_AUTHORIZED",
  not_selectable: "NOT_SELECTABLE",
  not_settable: "NOT_SETTABLE",
  element_unavailable: "ELEMENT_UNAVAILABLE",
  action_unavailable: "ACTION_UNAVAILABLE",
  foreground_required: "FOREGROUND_REQUIRED",
  launch_failed: "LAUNCH_FAILED",
  version_mismatch: "VERSION_MISMATCH",
  method_not_found: "METHOD_NOT_FOUND",
  timeout: "TIMEOUT",
  internal: "INTERNAL",
  unavailable: "UNAVAILABLE",
});

function toolResultText(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function toolResultFromValue(value) {
  if (value === undefined) return { content: [] };
  if (value && typeof value === "object" && Array.isArray(value.content)) return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }] };
}

function translateBrokerError(error) {
  const code = error instanceof BrokerError || error instanceof CuaHelperError ? error.code : undefined;
  const mapped = (code && ERROR_CODE_BY_BROKER[code]) ?? "INTERNAL";
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          kind: mapped,
          code: mapped,
          brokerCode: code ?? null,
          message: error instanceof Error ? error.message : String(error),
        }),
      },
    ],
    isError: true,
  };
}

/**
 * 创建 Computer Use 运行时。
 *
 * `execute` 把工具名转成 broker 方法调用；`closeSession` 关闭该会话的控制权；
 * `dispose` 释放客户端持有的 socket 引用。会话上下文按 workspace + session 隔离，
 * 不同 subagent 不共用 controller lease。
 */
export function createComputerUseRuntime(options = {}) {
  let socketPath =
    typeof options.brokerSocketPath === "string" && options.brokerSocketPath.trim()
      ? options.brokerSocketPath.trim()
      : resolveBrokerSocketPath({ env: options.env });

  let disposed = false;
  let ensureBrokerPromise = null;

  const ensureBroker = async () => {
    if (disposed) throw new CuaHelperError("Computer Use runtime is disposed", { code: "disposed" });
    if (typeof options.ensureBrokerAvailable === "function") {
      if (!ensureBrokerPromise) {
        ensureBrokerPromise = Promise.resolve()
          .then(() => options.ensureBrokerAvailable())
          .catch((error) => {
            ensureBrokerPromise = null;
            throw error;
          });
      }
      await ensureBrokerPromise;
      socketPath =
        typeof options.brokerSocketPath === "string" && options.brokerSocketPath.trim()
          ? options.brokerSocketPath.trim()
          : resolveBrokerSocketPath({ env: options.env });
    }
    return socketPath;
  };

  return {
    async execute(input) {
      const toolName = input?.toolName;
      if (typeof toolName !== "string" || !toolName.trim()) {
        return toolResultText("Computer Use toolName must be a non-empty string");
      }
      const method = toolName.trim();
      if (!COMPUTER_METHOD_NAMES.includes(method)) {
        return toolResultText(
          `Unknown Computer Use tool: ${method}. Known tools: ${COMPUTER_METHOD_NAMES.join(", ")}`,
        );
      }

      try {
        if (typeof options.ensureBrokerAvailable === "function") {
          await ensureBroker();
        }
        const result = await callBrokerMethod({
          socketPath: await ensureBroker(),
          method,
          params: input?.arguments ?? {},
          timeoutMs: timeoutFor(method),
        });
        return toolResultFromValue(result);
      } catch (error) {
        return translateBrokerError(error);
      }
    },

    async closeSession(context) {
      if (disposed) return;
      try {
        // 只有会改变 UI 的动作持有 controller lease，收尾时显式归还；
        // 只读工具没有 lease，这里不发 controller_stop 以免误伤其它会话的控制权。
        await callBrokerMethod({
          socketPath,
          method: "controller_stop",
          params: {
            sessionId: context?.sessionId,
            workspaceKey: context?.workspaceKey,
          },
          timeoutMs: 3_000,
        });
      } catch {
        // 收尾失败不抛：会话已在结束流程里，抛错只会污染上层 close 链路。
      }
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      ensureBrokerPromise = null;
    },
  };
}

function timeoutFor(method) {
  // 截图/取状态链路要过原生无障碍与屏幕捕获，给更长预算；
  // 其余动作按 helper 默认的 15s 走，超时由上层按 possibly_sent 语义决定是否重试。
  return method === "get_app_state" || method === "capture" ? 30_000 : 15_000;
}

export {
  COMPUTER_METHOD_NAMES,
  CUA_BROKER_IPC_VERSION,
  isMutatingBrokerMethod,
  probeHelperHealth,
};
