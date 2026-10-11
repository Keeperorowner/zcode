#!/usr/bin/env node

import process from "node:process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareWindowsCuaHelperAssets,
  resolveWindowsCuaHelperSourceRoot,
} from "./windows-cua-helper-assets.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopPackageRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopPackageRoot, "..", "..");
const servicesPackageRoot = resolve(desktopPackageRoot, "..", "services");
const targetPlatform = getTargetPlatform();

if (targetPlatform.os !== "win32") {
  console.log("[prepare-windows-cua-helper] skip unsupported platform");
  process.exit(0);
}

const desktopPackage = JSON.parse(
  await readFile(resolve(desktopPackageRoot, "package.json"), "utf8"),
);
// 本仓库的 Helper 运行时随源码分发在 `vendor/zcode-cua-helper`（见该目录 README）。
// 上游的默认解析路径是「已安装的 @zcode/zcode-cua 包」，而开源树里那个包是 fail-closed
// 占位包、没有原生 Helper，所以这里把默认来源改成仓库内的 vendor 目录。
// 显式传入 ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR 时仍以调用方为准（上游语义不变）。
const sourceRoot = await resolveWindowsCuaHelperSourceRoot({
  runtimePackageDir:
    process.env.ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR?.trim() ||
    resolve(repoRoot, "vendor", "zcode-cua-helper"),
  devRoot: process.env.ZCODE_CUA_DEV_ROOT,
  servicesPackageRoot,
});
const result = await prepareWindowsCuaHelperAssets({
  sourceRoot,
  outputRoot: resolve(desktopPackageRoot, "bundled-tools"),
  targetPlatform,
  electronVersion: desktopPackage.devDependencies.electron,
});

console.log(
  `[prepare-windows-cua-helper] staged ${result.manifest.packageVersion} ${result.manifest.platform}/${result.manifest.arch} PE=0x${result.peMachine.toString(16)} -> ${result.outputDir}`,
);
