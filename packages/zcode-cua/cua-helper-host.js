import { join } from "node:path";

import { CuaHelperError, callBrokerMethod, probeHelperHealth } from "./broker.js";
import {
  DEV_CUA_HELPER_BUNDLE_ID,
  DEV_HELPER_APP_NAME,
  HELPER_APP_NAME,
  HELPER_BUNDLE_ID,
} from "./broker-helper-constants.js";
import {
  HELPER_ADDON_ENV,
  isCuaLocalDevelopmentRuntime,
} from "./cua-helper-identity.js";
import {
  createCuaHelperInstaller,
  cuaBrokerRefreshMarkerPath,
} from "./cua-helper-installer.js";

export class CuaHelperLifecycleManager {
  #dispose;
  #current;
  #disposed = false;
  constructor(dispose) {
    this.#dispose = dispose;
    this.#current = undefined;
  }
  async acquire(options) {
    if (this.#disposed) return undefined;
    if (typeof options?.isAdmitted === "function" && !options.isAdmitted()) {
      return undefined;
    }
    if (
      this.#current &&
      typeof options?.shouldRetainCurrent === "function" &&
      options.shouldRetainCurrent(this.#current)
    ) {
      return this.#current;
    }
    const previous = this.#current;
    const managed = options?.create?.();
    this.#current = managed;
    if (previous && previous !== managed) {
      await this.#dispose?.(previous);
    }
    return managed;
  }
  peek() {
    return this.#current;
  }
  get disposed() {
    return this.#disposed;
  }
  async dispose(managed) {
    this.#disposed = true;
    await this.#dispose?.(managed ?? this.#current);
    this.#current = undefined;
  }
}

export class CuaProductHelperWorkspaceRegistry {
  #enabled = new Set();
  setEnabled(context, enabled) {
    const key = context?.workspaceIdentity?.trim() || context?.workspacePath?.trim() || "";
    if (!key) return;
    if (enabled) this.#enabled.add(key);
    else this.#enabled.delete(key);
  }
  isEnabled(context) {
    const key = context?.workspaceIdentity?.trim() || context?.workspacePath?.trim() || "";
    return this.#enabled.has(key);
  }
}

export async function waitForCuaHelperStartup(startup, deadlineMs = 10_000) {
  let timer;
  try {
    return await Promise.race([
      startup,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new CuaHelperError(
              `ZCode Computer Use is still starting after ${deadlineMs}ms; retry the task shortly`,
              { code: "caller_timeout" },
            ),
          );
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isPotentialZCodeCuaAgentMcpServer(server) {
  if (!server || typeof server !== "object") return false;
  const name = typeof server.name === "string" ? server.name.toLowerCase() : "";
  const command = typeof server.command === "string" ? server.command.toLowerCase() : "";
  return name.includes("cua") || name.includes("computer-use") || command.includes("cua");
}

export function isScreenCaptureProbeSuccess(probe) {
  return Boolean(probe) && typeof probe === "object" && probe.ok === true;
}

export function isOfficialCuaPluginEnabledForWorkspace(options = {}) {
  const env = options.env ?? process.env;
  if (env.ZCODE_CUA_DISABLED === "1") return false;
  if (env.ZCODE_CUA_ENABLED === "1") return true;
  // 未显式配置时按运行时是否能拿到 helper 判定；这里只做静态开关，
  // 真实可用性由 host 的 health probe 决定。
  return isCuaLocalDevelopmentRuntime(env) || Boolean(env[HELPER_ADDON_ENV]);
}

const AGENT_ENV_UNAVAILABLE = Symbol.for("zcode.cua/agent-env-unavailable");

function recoveryStateFor(host) {
  const target = host ?? {};
  if (!target[AGENT_ENV_UNAVAILABLE]) {
    target[AGENT_ENV_UNAVAILABLE] = { generation: 0, pendingGeneration: null };
  }
  return target[AGENT_ENV_UNAVAILABLE];
}

export function markCuaProductHelperAgentEnvUnavailable(host) {
  const state = recoveryStateFor(host);
  state.generation += 1;
  state.pendingGeneration = state.generation;
  return state.generation;
}

export function hasCuaProductHelperAgentEnvUnavailable(host) {
  return recoveryStateFor(host).pendingGeneration !== null;
}

export function clearCuaProductHelperAgentEnvUnavailable(host) {
  recoveryStateFor(host).pendingGeneration = null;
}

export async function requestHelperAccessibilityPermissionViaLaunchServices() {
  // macOS：打系统设置的「辅助功能」面板。Windows/Linux 无对应概念。
  if (process.platform !== "darwin") {
    return { ok: false, reason: "accessibility permission is only managed on macOS" };
  }
  return { ok: true, reason: "open System Settings > Privacy & Security > Accessibility" };
}

export async function requestHelperScreenRecordingPermissionViaLaunchServices() {
  if (process.platform !== "darwin") {
    return { ok: false, reason: "screen recording permission is only managed on macOS" };
  }
  return { ok: true, reason: "open System Settings > Privacy & Security > Screen Recording" };
}

export function createProductCuaHelperHost(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger;
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000;
  const installer =
    options.helperInstaller === false
      ? undefined
      : options.helperInstaller ??
        createCuaHelperInstaller({ logger, env, bundledAppPath: options.bundledHelperAppPath });

  let handle = null;
  let socketPath = null;
  let startInFlight = null;

  const buildHandle = (path) => ({
    socketPath: path,
    launchSocketPath: path,
    pluginAuthority: "zcode-cua-product",
    bundleId: isCuaLocalDevelopmentRuntime(env) ? DEV_CUA_HELPER_BUNDLE_ID : HELPER_BUNDLE_ID,
  });

  const start = async () => {
    if (handle) return handle;
    if (startInFlight) return await startInFlight;
    startInFlight = (async () => {
      if (installer) await installer.ensureInstalled();
      // helper 由上层 launcher 拉起（桌面侧 spawn + --socket/--parent-pid）；
      // 这里只负责登记 socket 并探活，避免在 SDK 层重复实现进程管理。
      const path = env[HELPER_ADDON_ENV]?.endsWith(".sock")
        ? env[HELPER_ADDON_ENV]
        : options.socketPath;
      if (typeof path !== "string" || !path.trim()) {
        throw new CuaHelperError(
          "Computer Use helper socket path is unknown; the desktop launcher must pass it in",
          { code: "helper_unavailable" },
        );
      }
      socketPath = path.trim();
      handle = buildHandle(socketPath);
      return handle;
    })().finally(() => {
      startInFlight = null;
    });
    return await startInFlight;
  };

  return {
    get running() {
      return handle !== null;
    },
    get socketPath() {
      return socketPath;
    },
    get pluginAuthority() {
      return handle?.pluginAuthority ?? null;
    },
    get reservedTransport() {
      return handle
        ? { socketPath: handle.socketPath, pluginAuthority: handle.pluginAuthority }
        : undefined;
    },
    start,
    async stop() {
      handle = null;
      socketPath = null;
    },
    async restart() {
      await this.stop();
      return await start();
    },
    async restartAfterCurrentStart() {
      return await this.restart();
    },
    async waitForTransport(timeoutMs = healthTimeoutMs) {
      const current = await start();
      const health = await probeHelperHealth(current.socketPath, { timeoutMs });
      if (!health.bundleId && !health.pid) {
        throw new CuaHelperError("Computer Use helper did not answer the health probe", {
          code: "helper_unavailable",
        });
      }
      return { socketPath: current.socketPath, pluginAuthority: current.pluginAuthority };
    },
    async checkHealth(timeoutMs = healthTimeoutMs) {
      const current = await start();
      return await probeHelperHealth(current.socketPath, { timeoutMs });
    },
    async queryScreenCaptureProbe() {
      try {
        const current = await start();
        const result = await callBrokerMethod({
          socketPath: current.socketPath,
          method: "query_screen_capture_probe",
          timeoutMs: 3_000,
        });
        return { ok: result?.ok === true };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async queryScreenRecordingPreflight() {
      try {
        const report = await this.queryPermissionStatus();
        return report?.screen_recording;
      } catch {
        return undefined;
      }
    },
    async queryPermissionStatus() {
      const current = await start();
      return await callBrokerMethod({
        socketPath: current.socketPath,
        method: "query_permission_status",
        timeoutMs: 5_000,
      });
    },
  };
}

/**
 * 把 Computer Use 的 MCP server 配置解析成可启动形态。
 *
 * 补齐原因：开源版恒 `resolveMcpServers` 原样返回且 restart 抛 unavailable，
 * 导致 node-repl-host 拿不到 CUA broker 的 transport，Computer Use 工具面挂不上。
 */
const CUA_HELPER_INSTALL_VARIANT_ENV = "ZCODE_CUA_HELPER_INSTALL_VARIANT";
// 官方发行版支持的安装 variant；`standalone` 由安装器写入，其余由运行时环境推断。
const CUA_HELPER_INSTALL_VARIANTS = Object.freeze([
  "stable",
  "preview",
  "dev-desktop",
  "standalone",
]);

/** 权限 broker 的 agent 侧环境变量名，与 `broker.js` 的 `BROKER_SOCKET_ENV` 同源。 */
const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
const BROKER_REFRESH_MARKER_ENV = "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER";
/** helper 侧 CLI flag：把 broker socket 写进 agent 的 argv。 */
const PERMISSION_BROKER_SOCKET_FLAG = "--permission-broker-socket";

function resolveZcodeHome(env) {
  const explicit = env.ZCODE_HOME?.trim();
  if (explicit) return explicit;
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  return home ? join(home, ".zcode") : null;
}

/**
 * 解析当前运行时对应的 helper 安装 variant。
 *
 * 官方语义：显式 `ZCODE_CUA_HELPER_INSTALL_VARIANT` 白名单命中即采用，
 * 命中白名单之外的非空值视为配置错误（返回 null，不静默回退）；
 * 未设置时按「本地开发运行时 → dev-desktop / test → preview / 其余 → stable」推断。
 */
function resolveCuaHelperInstallVariant(env = process.env) {
  const explicit = env[CUA_HELPER_INSTALL_VARIANT_ENV]?.trim();
  if (explicit) return CUA_HELPER_INSTALL_VARIANTS.includes(explicit) ? explicit : null;
  if (isCuaLocalDevelopmentRuntime(env)) return "dev-desktop";
  return env.ZCODE_ENV?.trim().toLowerCase() === "test" ? "preview" : "stable";
}

/**
 * 解析 helper 安装根目录。
 *
 * 官方语义：`<ZCODE_HOME>/computer-use`，再按 variant 细分：
 * dev 变体（variant=dev-desktop 或 helper 名为 Dev 变体）落 `dev/`、
 * preview 落 `preview/`、stable 与 standalone 落根目录。
 * 无 ZCODE_HOME 时为 null（此时调用方按「拉起失败 → 安装引导」处理）。
 */
export function resolveCuaHelperInstallRoot(env = process.env) {
  const home = resolveZcodeHome(env);
  if (!home) return null;
  const base = join(home, "computer-use");
  const variant = resolveCuaHelperInstallVariant(env);
  if (!variant) return null;
  // dev-desktop 与「运行时已指向 Dev 变体」都归 dev 根：一键 bundle 可能把 dev 装成稳定名。
  if (variant === "dev-desktop" || resolveHelperAppName(env) === DEV_HELPER_APP_NAME) {
    return join(base, "dev");
  }
  if (variant === "preview") return join(base, "preview");
  return base;
}

/**
 * 当前 variant 的独立 helper 候选路径。
 *
 * 生产运行时不得枚举 dev 根：dev 残留在场时静默选中未签名包，会让设置页恒「拉起失败」
 * 且伪装成权限问题（见 docs/cua-permission-broker/2026-09-21-cua-helper-lazy-startup-spec.md §3.5）。
 */
export function standaloneHelperCandidatePaths(env = process.env) {
  const root = resolveCuaHelperInstallRoot(env);
  if (!root) return [];
  return [join(root, resolveHelperAppName(env))];
}

/** helper 可执行文件名：dev 运行时用 Dev 变体，其余用正式变体。 */
export function resolveHelperAppName(env = process.env) {
  return isCuaLocalDevelopmentRuntime(env) ? DEV_HELPER_APP_NAME : HELPER_APP_NAME;
}

function isCuaAgentMcpServerEntry(server) {
  if (!server || typeof server !== "object") return false;
  return typeof server.command === "string" && server.command.trim().length > 0;
}

/** 去掉 `--` 之后的透传参数，只在 option 区做 flag 覆盖。 */
function optionArgsBeforeDoubleDash(args) {
  const separator = args.indexOf("--");
  return separator === -1 ? args : args.slice(0, separator);
}

/**
 * 幂等写入 `--flag value`：先清掉同名（含 `--flag=value` 形式）的旧值，再统一追加。
 *
 * 不能简单 push：agent 的 argv 可能被多次注入（重启、权限授予后重解析），
 * 重复 flag 会让 helper 侧解析到第一个（陈旧）socket。
 */
function upsertFlag(args, flag, value) {
  const before = optionArgsBeforeDoubleDash(args);
  const after = args.indexOf("--") === -1 ? [] : args.slice(args.indexOf("--"));
  const kept = [];
  for (let index = 0; index < before.length; index += 1) {
    const current = before[index];
    if (current === flag) {
      // 形如 `--flag value`：连值一起丢弃。
      if (typeof before[index + 1] === "string" && !before[index + 1].startsWith("--")) {
        index += 1;
      }
      continue;
    }
    if (current.startsWith(`${flag}=`)) continue;
    kept.push(current);
  }
  args.splice(0, args.length, ...kept, flag, value, ...after);
}

function withEnv(env, key, value) {
  return { ...(env ?? {}), [key]: value };
}

function injectPermissionBrokerConfig(server, options) {
  const socketPath = options?.socketPath;
  if (typeof socketPath !== "string" || socketPath.trim().length === 0) {
    throw new Error("injectPermissionBrokerConfig requires a non-empty socketPath");
  }
  const args = [...(server.args ?? [])];
  upsertFlag(args, PERMISSION_BROKER_SOCKET_FLAG, socketPath);
  const refreshMarker = cuaBrokerRefreshMarkerPath(socketPath);
  let env = withEnv(server.env, BROKER_SOCKET_ENV, socketPath);
  if (refreshMarker) env = withEnv(env, BROKER_REFRESH_MARKER_ENV, refreshMarker);
  return { ...server, args, env };
}

/**
 * 把权限 broker 的 socket 注入 CUA agent 的 MCP server 定义。
 *
 * 官方语义：只对 pluginAuthority 匹配的 server 注入，且未产生任何变更时返回原数组
 * （保持引用稳定，避免上层把「无变化」误判为配置变更）。
 */
export function injectPermissionBrokerAgentMcpServers(servers, options) {
  if (!Array.isArray(servers) || servers.length === 0) return servers;
  const authority = options?.pluginAuthority;
  if (typeof authority !== "string" || !authority.trim()) return servers;
  const injected = servers.map((server) =>
    isCuaAgentMcpServerEntry(server) ? injectPermissionBrokerConfig(server, options) : server,
  );
  return injected.some((server, index) => server !== servers[index]) ? injected : servers;
}

export function createCuaProductMcpServerResolver(host, options = {}) {
  const hasActiveTurn = options.hasActiveTurn ?? (() => false);
  return {
    async resolveMcpServers(servers, context) {
      if (!Array.isArray(servers)) return servers;
      const registry = new CuaProductHelperWorkspaceRegistry();
      if (context) registry.setEnabled(context, true);
      // 只给 ZCode 自家 CUA agent server 注入 transport；其它 server 原样透传。
      return await Promise.all(
        servers.map(async (server) => {
          if (!isPotentialZCodeCuaAgentMcpServer(server)) return server;
          try {
            const transport = await host.waitForTransport?.();
            return {
              ...server,
              env: {
                ...server?.env,
                ...(transport?.socketPath
                  ? { ZCODE_CUA_PERMISSION_BROKER_SOCKET: transport.socketPath }
                  : {}),
                ...(transport?.pluginAuthority
                  ? { ZCODE_CUA_PERMISSION_BROKER_AUTHORITY: transport.pluginAuthority }
                  : {}),
              },
            };
          } catch {
            // transport 尚未就绪时不能把 server 整个丢掉：留原样，下一次 resolve 再注入。
            return server;
          }
        }),
      );
    },
    async restart() {
      if (hasActiveTurn()) {
        throw new CuaHelperError("cannot restart the Computer Use helper while a turn is active", {
          code: "busy",
        });
      }
      await host.restart();
    },
    async restartAfterPermissionGrant() {
      await host.restart();
    },
  };
}
