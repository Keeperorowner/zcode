#!/usr/bin/env node

/**
 * Computer Use 还原的正确性门禁。
 *
 * 上游开源树把 `@zcode/zcode-cua` 发成 fail-closed 占位包（`zcodeCuaPlaceholder: true`），
 * 真 producer 闭源。本仓库还原了实现体与 Windows 原生 Helper，这个脚本负责证明「还原是
 * 完整且自洽的」，让 CI 在打包前就拦住三类回归：
 *
 *   1. 契约缺失 —— `*.d.ts` 声明的导出在对应 `.js` 里不存在（模块能 import 但调用即崩）。
 *   2. 占位回归 —— 有人把实现体改回桩，或把 `zcodeCuaPlaceholder` 又加回 package.json。
 *   3. vendor 漂移 —— `vendor/zcode-cua-helper` 的 entry/addon 与 `runtime-manifest.json`
 *      记录的 SHA-256 或 PE 架构不一致（打包出的 Helper 起不来或与宿主 ABI 不匹配）。
 *
 * 用法：`node scripts/verify-computer-use-restoration.mjs`（仓库根目录执行）。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cuaPackageRoot = resolve(repoRoot, "packages", "zcode-cua");
const vendorRoot = resolve(repoRoot, "vendor", "zcode-cua-helper");

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function note(message) {
  notes.push(message);
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * 从 `.d.ts` 里抽取 `export declare function|const|class` 的名字。
 * 只做保守解析：还原的是「契约条目是否被实现」这一层，不做类型级校验。
 */
function readDeclaredExportNames(dtsSource) {
  const names = new Set();
  const patterns = [
    /export\s+declare\s+function\s+([A-Za-z0-9_$]+)/gu,
    /export\s+declare\s+const\s+([A-Za-z0-9_$]+)/gu,
    /export\s+declare\s+class\s+([A-Za-z0-9_$]+)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of dtsSource.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

/**
 * 校验 `packages/zcode-cua` 的每个公开入口：`.d.ts` 声明的导出必须都能从 `.js` 实际取到。
 */
async function verifyContractSurface() {
  const entries = [
    ["broker.js", "broker.d.ts"],
    ["broker-server.js", "broker-server.d.ts"],
    ["broker-ports.js", "broker-ports.d.ts"],
    ["broker-socket-path.js", "broker-socket-path.d.ts"],
    ["broker-helper-health.js", "broker-helper-health.d.ts"],
    ["frame-contract.js", "frame-contract.d.ts"],
    ["host-display-contract.js", "host-display-contract.d.ts"],
    ["index.js", "index.d.ts"],
    ["pip-session-node.js", "pip-session-node.d.ts"],
    ["request-access-contract.js", "request-access-contract.d.ts"],
  ];

  for (const [jsName, dtsName] of entries) {
    const jsPath = resolve(cuaPackageRoot, jsName);
    const dtsPath = resolve(cuaPackageRoot, dtsName);
    if (!existsSync(jsPath)) {
      fail(`missing implementation module: packages/zcode-cua/${jsName}`);
      continue;
    }
    if (!existsSync(dtsPath)) {
      fail(`missing contract declaration: packages/zcode-cua/${dtsName}`);
      continue;
    }

    const declared = readDeclaredExportNames(readFileSync(dtsPath, "utf8"));
    if (declared.size === 0) continue;

    let loaded;
    try {
      loaded = await import(new URL(`../packages/zcode-cua/${jsName}`, import.meta.url).href);
    } catch (error) {
      fail(`cannot load packages/zcode-cua/${jsName}: ${error.message}`);
      continue;
    }

    const missing = [...declared].filter((name) => !(name in loaded));
    if (missing.length > 0) {
      fail(
        `packages/zcode-cua/${jsName} is missing declared exports: ${missing.join(", ")}`,
      );
    }
  }
  note(`contract surface: checked ${entries.length} entry modules`);
}

/**
 * 还原后不应再出现占位标记，且关键实现函数不能是「恒 false / 恒空」的桩。
 */
function verifyNotPlaceholder() {
  const manifestPath = resolve(cuaPackageRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.zcodeCuaPlaceholder === true) {
    fail("packages/zcode-cua/package.json still declares zcodeCuaPlaceholder: true");
  }
  if (manifest.zcodeCuaRuntime?.schema !== 1) {
    fail("packages/zcode-cua/package.json is missing the zcodeCuaRuntime schema 1 contract");
  }
  const windowsContract = manifest.zcodeCuaRuntime?.windows;
  if (!windowsContract?.entry || !windowsContract?.nativeAddon) {
    fail("packages/zcode-cua/package.json zcodeCuaRuntime.windows must define entry and nativeAddon");
  }

  // 这些是上游桩里被抽空的关键实现；只要其中一个退回桩，CUA 链路就会静默失效。
  const hostSource = readFileSync(resolve(cuaPackageRoot, "cua-helper-host.js"), "utf8");
  for (const marker of [
    "resolveCuaHelperInstallRoot",
    "standaloneHelperCandidatePaths",
    "injectPermissionBrokerAgentMcpServers",
    "createProductCuaHelperHost",
  ]) {
    if (!hostSource.includes(`function ${marker}`) && !hostSource.includes(`function ${marker}(`)) {
      fail(`cua-helper-host.js is missing the restored implementation of ${marker}`);
    }
  }

  const brokerSource = readFileSync(resolve(cuaPackageRoot, "broker.js"), "utf8");
  if (!brokerSource.includes("function callBrokerMethod")) {
    fail("broker.js is missing the restored callBrokerMethod implementation");
  }
  if (/function isBrokerMethod\([^)]*\)\s*\{\s*return false;\s*\}/u.test(brokerSource)) {
    fail("broker.js isBrokerMethod is still a hardcoded false stub");
  }

  const indexPath = resolve(cuaPackageRoot, "index.js");
  const indexSource = readFileSync(indexPath, "utf8");
  // 只匹配「真的返回占位结果」的实现体，不匹配解释历史成因的注释。
  if (/return\s*\{[^}]*content:\s*\[\{\s*type:\s*"text",\s*text:\s*UNAVAILABLE_TEXT/u.test(indexSource)) {
    fail("index.js still returns the placeholder unavailable result");
  }
  if (!indexSource.includes("COMPUTER_METHOD_NAMES")) {
    fail("index.js is missing the restored Computer Use tool dispatch table");
  }
  note("placeholder check: implementation bodies are present");
}

/**
 * vendor 的 Helper 运行时必须与 `runtime-manifest.json` 自述一致。
 * 这是「构建产物能起来」的最小前提：entry 是实际执行的 JS，addon 是原生 ABI 面。
 */
function verifyVendoredHelper() {
  const manifestPath = resolve(vendorRoot, "runtime-manifest.json");
  if (!existsSync(manifestPath)) {
    fail("vendor/zcode-cua-helper/runtime-manifest.json is missing");
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  if (manifest.schemaVersion !== 1) fail("helper runtime-manifest schemaVersion must be 1");
  if (manifest.packageName !== "@zcode/zcode-cua") {
    fail(`helper runtime-manifest packageName must be @zcode/zcode-cua, got ${manifest.packageName}`);
  }
  if (manifest.platform !== "win32") fail("helper runtime-manifest platform must be win32");

  for (const [label, relativePath, expectedHash] of [
    ["entry", manifest.entry, manifest.sha256?.entry],
    ["addon", manifest.addon, manifest.sha256?.addon],
  ]) {
    const artifactPath = resolve(vendorRoot, relativePath ?? "");
    if (!relativePath || !existsSync(artifactPath)) {
      fail(`vendor helper ${label} is missing: ${relativePath}`);
      continue;
    }
    const actual = sha256(artifactPath);
    if (expectedHash && actual !== expectedHash) {
      fail(
        `vendor helper ${label} SHA-256 mismatch: manifest=${expectedHash} actual=${actual} (${relativePath})`,
      );
    }
  }

  // PE 头校验：x64 必须是 0x8664。架构不符时 Helper 在目标机上直接起不来，
  // 而这种问题只在运行时暴露，必须在 CI 阶段拦住。
  const addonPath = resolve(vendorRoot, manifest.addon ?? "");
  if (existsSync(addonPath)) {
    const bytes = readFileSync(addonPath);
    const peOffset = bytes.readUInt32LE(0x3c);
    const machine = bytes.readUInt16LE(peOffset + 4);
    if (manifest.arch === "x64" && machine !== 0x8664) {
      fail(`vendor helper addon PE machine is 0x${machine.toString(16)}, expected 0x8664 (x64)`);
    }
    notes.push(`vendor helper addon PE machine=0x${machine.toString(16)}`);
  }

  const vendorManifest = resolve(vendorRoot, "package.json");
  if (existsSync(vendorManifest)) {
    const pkg = JSON.parse(readFileSync(vendorManifest, "utf8"));
    const contract = pkg.zcodeCuaRuntime?.windows;
    if (contract?.entry !== manifest.entry || contract?.nativeAddon !== manifest.addon) {
      fail(
        "vendor package.json zcodeCuaRuntime.windows disagrees with runtime-manifest.json " +
          `(pkg=${JSON.stringify(contract)} manifest={entry:${manifest.entry},addon:${manifest.addon}})`,
      );
    }
  }
  note("vendored helper: manifest, hashes and PE machine verified");
}

await verifyContractSurface();
verifyNotPlaceholder();
verifyVendoredHelper();

for (const line of notes) console.log(`  - ${line}`);

if (failures.length > 0) {
  console.error("\n[verify-computer-use-restoration] FAILED:");
  for (const line of failures) console.error(`  x ${line}`);
  process.exit(1);
}

console.log("\n[verify-computer-use-restoration] OK");
