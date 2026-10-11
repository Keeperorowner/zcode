import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { CuaHelperError } from "./broker.js";
import {
  DEV_CUA_HELPER_BUNDLE_ID,
  HELPER_BUNDLE_ID,
} from "./broker-helper-constants.js";

export const HELPER_ADDON_ENV = "ZCODE_CUA_HELPER_ADDON";
export const WINDOWS_DEV_CONTROL_PROTOCOL = "zcode-cua-windows-dev/v1";

export const require_ = createRequire(import.meta.url);
export const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * 构造 helper 启动 argv。
 *
 * 补齐原因：开源版返回 `[]`，helper 根本起不来。helper 侧
 * （`windows-helper.js` 的 dev-control 解析）硬性要求正好 4 个参数且同时含
 * `--socket` 与 `--parent-pid`，否则拒绝启动。
 */
export function buildHelperOpenArgs(spec, launcherPid) {
  const socketPath = spec?.socketPath ?? spec?.socket;
  if (typeof socketPath !== "string" || !socketPath.trim()) {
    throw new CuaHelperError("buildHelperOpenArgs requires spec.socketPath", {
      code: "invalid_argument",
    });
  }
  const pid = Number.isFinite(launcherPid) ? launcherPid : process.pid;
  return ["--socket", socketPath, "--parent-pid", String(pid)];
}

export function isCuaLocalDevelopmentRuntime(env = process.env, compiledLocalDevelopmentRuntime) {
  if (compiledLocalDevelopmentRuntime === true) return true;
  if (env.ZCODE_CUA_LOCAL_DEVELOPMENT === "1") return true;
  if (env.ZCODE_CUA_HELPER_ADDON && isAbsolute(env.ZCODE_CUA_HELPER_ADDON)) return true;
  return false;
}

export async function resolveHelperPermissionSubjectIdentity(appPath) {
  if (typeof appPath !== "string" || !appPath.trim()) {
    throw new CuaHelperError("resolveHelperPermissionSubjectIdentity requires appPath", {
      code: "invalid_argument",
    });
  }
  const normalized = resolve(appPath);
  const isDev = basenameLooksLikeDevHelper(normalized);
  return {
    appPath: normalized,
    // macOS 的权限主体是 .app 包内的主可执行文件；Windows 侧直接用安装目录。
    executablePath: normalized,
    displayName: isDev ? "ZCode Computer Use Dev" : "ZCode Computer Use",
    bundleId: isDev ? DEV_CUA_HELPER_BUNDLE_ID : HELPER_BUNDLE_ID,
  };
}

function basenameLooksLikeDevHelper(appPath) {
  return /Dev\.app$/i.test(appPath) || /-dev$/i.test(appPath);
}

export function resolveDefaultBundledHelperPath(env) {
  const fromEnv = env[HELPER_ADDON_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  // 默认布局：resources/tools/cua-helper/build/Release/ax_native.node
  // （见 runtime-manifest.json 的 addon 字段）。
  const guess = resolve(moduleDir, "..", "..", "tools", "cua-helper", "build", "Release", "ax_native.node");
  return existsSync(guess) ? guess : undefined;
}
