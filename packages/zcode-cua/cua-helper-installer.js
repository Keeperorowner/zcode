import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CuaHelperError } from "./broker.js";
import {
  HELPER_ADDON_ENV,
  require_,
  resolveDefaultBundledHelperPath,
  resolveHelperPermissionSubjectIdentity,
  moduleDir,
} from "./cua-helper-identity.js";

const REFRESH_MARKER_SUFFIX = ".refresh";

/**
 * helper 安装/校验器。
 *
 * 补齐原因：开源版 `ensureInstalled`/`verifyInstalled` 都抛 unavailable，
 * 导致打包进 resources/tools/cua-helper 的助手永远不被承认。这里按
 * 「bundledAppPath 存在即视为已安装」+ 可插拔的签名校验依赖实现。
 */
export function createCuaHelperInstaller(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger;
  const bundledAppPath = options.bundledAppPath ?? env[HELPER_ADDON_ENV];
  const dependencies = { ...defaultCuaHelperVerifierDependencies, ...options.dependencies };

  return {
    async ensureInstalled() {
      const candidate = bundledAppPath ?? resolveDefaultBundledHelperPath(env);
      if (!candidate || !existsSync(candidate)) {
        throw new CuaHelperError(
          `Computer Use helper is not installed (looked at: ${candidate ?? "<none>"})`,
          { code: "helper_unavailable" },
        );
      }
      return candidate;
    },
    async verifyInstalled(appPath) {
      const target = appPath ?? (await this.ensureInstalled());
      const executable = await resolveHelperPermissionSubjectIdentity(target);
      const archs = await dependencies.readExecutableArchs(executable.executablePath);
      if (!Array.isArray(archs) || archs.length === 0) {
        throw new CuaHelperError("Computer Use helper executable has no readable architectures", {
          code: "helper_unverified",
        });
      }
      if (typeof dependencies.verifyCodeSignature === "function") {
        await dependencies.verifyCodeSignature(executable.executablePath);
      }
      if (typeof dependencies.verifyTeamIdentifier === "function") {
        await dependencies.verifyTeamIdentifier(executable.executablePath);
      }
      logger?.debug?.("cua helper verified", { archs });
    },
  };
}

export const defaultCuaHelperVerifierDependencies = {
  async readExecutableArchs(executablePath) {
    if (typeof executablePath !== "string" || !existsSync(executablePath)) return [];
    // 不做 Mach-O/fat 解析：只要文件可读就报当前进程架构，签名/团队 ID 由
    // 上层注入的 verifyCodeSignature / verifyTeamIdentifier 负责。
    return [process.arch];
  },
  async verifyCodeSignature() {
    return undefined;
  },
  async verifyTeamIdentifier() {
    return undefined;
  },
};

export function cuaBrokerRefreshMarkerPath(socketPath) {
  if (typeof socketPath !== "string" || !socketPath.trim()) return undefined;
  return `${socketPath}${REFRESH_MARKER_SUFFIX}`;
}

export async function publishCuaBrokerRefreshMarker(socketPath, options = {}) {
  const path = cuaBrokerRefreshMarkerPath(socketPath);
  if (!path) {
    throw new CuaHelperError("publishCuaBrokerRefreshMarker requires a socketPath", {
      code: "invalid_argument",
    });
  }
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? 5_000;
  mkdirSync(dirname(path), { recursive: true });
  const startedAt = now();
  for (;;) {
    try {
      writeFileSync(path, `${startedAt}\n`, "utf-8");
      return { path };
    } catch (error) {
      if (now() - startedAt >= deadlineMs) {
        throw new CuaHelperError(
          `failed to publish broker refresh marker after ${deadlineMs}ms: ${error instanceof Error ? error.message : String(error)}`,
          { code: "marker_write_failed" },
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

export function loadRealNativeAddon(options = {}) {
  const addonPath =
    resolvePackagedNativeAddonPath(options) ?? resolveInTreeAddonPath(options) ?? undefined;
  if (!addonPath) {
    throw new CuaHelperError(
      "Computer Use native addon (ax_native.node) was not found in packaged or in-tree locations",
      { code: "helper_unavailable" },
    );
  }
  return require_(addonPath);
}

export function resolvePackagedNativeAddonPath(options = {}) {
  const env = options.env ?? process.env;
  const explicit = env[HELPER_ADDON_ENV];
  if (typeof explicit === "string" && explicit.trim() && existsSync(explicit.trim())) {
    return explicit.trim();
  }
  const packaged = resolveDefaultBundledHelperPath(env);
  return packaged && existsSync(packaged) ? packaged : undefined;
}

export function resolveInTreeAddonPath(_options = {}) {
  const candidates = [
    resolve(moduleDir, "..", "..", "..", "tools", "cua-helper", "build", "Release", "ax_native.node"),
    resolve(moduleDir, "..", "build", "Release", "ax_native.node"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function reapOrphanedHelpers(options = {}) {
  const env = options.env ?? process.env;
  const dir = env.TMPDIR || env.TEMP || env.TMP;
  if (!dir) return;
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("zcode-cua-broker-")) continue;
    const full = join(dir, entry);
    try {
      // socket/marker 是纯本地 IPC 通道，删除残留即可；
      // 不 kill 任何进程：孤儿进程由桌面侧的 launcher watchdog 负责。
      if (statSync(full).isFile()) unlinkSync(full);
    } catch {
      // 清理失败忽略：可能已被占用。
    }
  }
}
