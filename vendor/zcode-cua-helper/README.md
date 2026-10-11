# vendor/zcode-cua-helper — Computer Use 原生 Helper 运行时

这个目录**不是本仓库编写的源码**，而是从官方 ZCode 发行版中按字节还原的运行时产物，
用于补齐上游开源树缺失的 Computer Use 能力。

## 来源

提取自官方安装包 `ZCode-3.14.5-win-x64.exe` 内的
`resources/tools/cua-helper/`。该目录同时带有官方随包自述
`runtime-manifest.json`，其原文即为：

```json
{
  "schemaVersion": 1,
  "packageName": "@zcode/zcode-cua",
  "packageVersion": "0.6.3",
  "platform": "win32",
  "arch": "x64",
  "electronVersion": "41.0.3",
  "entry": "dist/windows-helper.js",
  "addon": "build/Release/ax_native.node",
  "sha256": {
    "entry": "88b7e601df94cae155f34fd771f9aaeda41dfb0bbadcc33daf89d434a364196e",
    "addon": "d6c9684105d05b00478064fe631ffd1fe3792554ccd9b5255e76ccd54054f644"
  }
}
```

本目录内容与该 manifest 逐字节一致，可用 `node scripts/verify-computer-use-restoration.mjs` 复验。

## 内容

| 路径 | 说明 |
|---|---|
| `dist/windows-helper.js` | Helper 入口（ESM，约 1.0 MB） |
| `build/Release/ax_native.node` | 原生 addon（Windows 无障碍 / 屏幕捕获），PE machine `0x8664` |
| `node_modules/` | 运行时依赖闭包：`express@5.2.1` + `sharp@0.34.5`（含 `@img/sharp-win32-x64` 的 libvips DLL） |
| `runtime-manifest.json` | 官方随包自述（哈希与架构契约） |
| `package.json` | producer 契约 `zcodeCuaRuntime.schema = 1`，供构建链识别 |

## 许可

版权归 **Z.ai** 所有。该目录内容随官方发行版分发，**仅供个人、教育与非商业使用**；
商业使用需事先取得 Z.ai 书面许可。详见仓库根目录 [NOTICE.md](../../NOTICE.md) 与
[docs/COMPUTER-USE-RESTORATION.md](../../docs/COMPUTER-USE-RESTORATION.md) §六。

## 维护注意

- **不要修改这里的任何文件。** 哈希与 PE 架构由 CI 门禁校验，改动会让构建失败。
- **不要移除 `.gitattributes` 里的 `vendor/zcode-cua-helper/** -text binary`。** 一旦 Git 做
  CRLF 规范化，`windows-helper.js` 的 SHA-256 会失配、`.node` 会加载失败。
- 升级到新的官方版本时，需重新提取并同步更新 `runtime-manifest.json`、`package.json` 的
  `zcodeCuaRuntime` 契约，以及 `verify-computer-use-restoration.mjs` 里的预期值。
- 仅含 **Windows x64** 产物。macOS 侧的 Helper 是 `.app` 形态、由闭源 producer 产出，本仓库不含。
