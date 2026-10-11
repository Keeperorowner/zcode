/**
 * `@zcode/zcode-cua/broker/server` 入口。
 *
 * 上游开源版这里是「全 fail-closed 桩」：helper 安装根恒 null、候选路径恒空、
 * MCP 注入原样返回。真实实现只存在于闭源 producer。本仓库按官方发行版
 * （ZCode 3.14.5 / 3.15.1）的运行时行为还原这套契约。
 *
 * 还原依据（可复验）：
 *   - 官方安装目录 `resources/tools/cua-helper/` 携带
 *     `dist/windows-helper.js` + `build/Release/ax_native.node` +
 *     `runtime-manifest.json`（entry/addon/sha256 契约），见
 *     `packages/zcode-cua-helper/`。
 *   - 官方 `resources/glm/packages/zcode-cua-plugin/` 的
 *     `scripts/computer-use-client.mjs` 给出工具名清单。
 *   - `broker-server.d.ts` 是本文件的唯一契约来源，导出面必须逐条对齐。
 *
 * 按契约分组拆到同目录模块，本文件只做转发：
 *   - cua-helper-identity.js   启动 argv / 权限主体 / 本地开发判定
 *   - cua-helper-installer.js  安装校验 / 原生 addon 加载 / refresh marker
 *   - cua-ax-roles.js          AX role→kind 映射与只读方法集
 *   - cua-helper-host.js       helper 宿主生命周期 / MCP resolver
 */
export {
  HELPER_ADDON_ENV,
  WINDOWS_DEV_CONTROL_PROTOCOL,
  buildHelperOpenArgs,
  isCuaLocalDevelopmentRuntime,
  resolveHelperPermissionSubjectIdentity,
} from "./cua-helper-identity.js";

export {
  createCuaHelperInstaller,
  defaultCuaHelperVerifierDependencies,
  cuaBrokerRefreshMarkerPath,
  publishCuaBrokerRefreshMarker,
  loadRealNativeAddon,
  resolvePackagedNativeAddonPath,
  resolveInTreeAddonPath,
  reapOrphanedHelpers,
} from "./cua-helper-installer.js";

export { ROLE_TO_KIND, roleToKind, createAxReadOnlyMethods } from "./cua-ax-roles.js";

export {
  CuaHelperLifecycleManager,
  CuaProductHelperWorkspaceRegistry,
  createProductCuaHelperHost,
  createCuaProductMcpServerResolver,
  isOfficialCuaPluginEnabledForWorkspace,
  waitForCuaHelperStartup,
  isPotentialZCodeCuaAgentMcpServer,
  isScreenCaptureProbeSuccess,
  markCuaProductHelperAgentEnvUnavailable,
  hasCuaProductHelperAgentEnvUnavailable,
  clearCuaProductHelperAgentEnvUnavailable,
  requestHelperAccessibilityPermissionViaLaunchServices,
  requestHelperScreenRecordingPermissionViaLaunchServices,
  injectPermissionBrokerAgentMcpServers,
  resolveHelperAppName,
  resolveCuaHelperInstallRoot,
  standaloneHelperCandidatePaths,
} from "./cua-helper-host.js";

export { HELPER_APP_NAME, DEV_HELPER_APP_NAME } from "./broker-helper-constants.js";
