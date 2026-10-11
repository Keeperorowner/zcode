# Computer Use 还原说明

> 本文件说明：上游开源树到底缺了什么、本仓库补齐了什么、依据是什么、怎么复验。

## 一、结论先行

**上游 `zai-org/ZCode` 在 v3.15.1（2026-10-10）已经修掉了大部分缺口**，所以本仓库直接以
v3.15.1 为基底，不再需要早期版本那种「手工搬运插件层」的做法。

| 缺口 | v3.14.x 状态 | v3.15.1 状态 | 本仓库处置 |
|---|---|---|---|
| 15 个官方插件源码 | ❌ 未上传 | ✅ 已在 `apps/zcode-cli/packages/` | 直接使用上游 |
| `bundled-skills` | ❌ 无 | ✅ 已入库 | 直接使用上游 |
| 文档技能许可 | ⚠️ 仅限个人/非商业 | ✅ 改为 Apache-2.0 | 直接使用上游 |
| native-search 预编译归档 | ❌ 需内网下载 | ✅ 18 个归档入库 + SHA256SUMS | 直接使用上游 |
| **`@zcode/zcode-cua` 真实现** | ❌ 空桩 | ❌ **仍是空桩** | ✅ **本仓库还原** |
| **CUA 原生 Helper 运行时** | ❌ 无 | ❌ 无（闭源私有） | ✅ **本仓库还原** |

也就是说：**唯一剩下的、上游故意不发的东西就是 Computer Use**，本仓库把它补上了。

## 二、上游为什么留这个缺口

上游是「能力完整、实现闭源」的取舍，不是遗漏：

- `packages/zcode-cua/package.json` 带 `"zcodeCuaPlaceholder": true`。
- `NOTICE.md` 明确写：「本仓库随附的 Computer Use 包为不可用占位实现，调用会返回不可用错误，
  不提供系统截图或操作能力」。
- 构建链有一道门 `isRealComputerUseProducerInstalled()`：检测到占位包时**自动跳过**所有
  Helper 相关步骤（编译 Helper、暂存原生依赖、打包 Helper 资源、打包后校验）。
  见 `docs/desktop/computer-use-producer-detection.md`。

所以开源构建出来的包**不会有** `resources/tools/cua-helper/`，Computer Use 整条链路 fail-closed。

## 三、本仓库还原了什么

### 3.1 `packages/zcode-cua` 的实现体

上游开源版把这些函数写成「恒 false / 恒空 / 抛 unavailable」的桩。按 `*.d.ts` 契约与官方
发行版运行时行为还原：

| 文件 | 还原内容 |
|---|---|
| `index.js` | `createComputerUseRuntime` 真正的工具派发（14 个工具名 → broker 方法） |
| `broker.js` | broker 方法表、`callBrokerMethod` IPC、错误码映射、socket 解析 |
| `broker-server.js` | 契约转发入口（35 个导出） |
| `cua-helper-identity.js` | `buildHelperOpenArgs` 4 参 argv、权限主体 identity、dev 判定 |
| `cua-helper-installer.js` | 安装校验、原生 addon 加载、refresh marker、孤儿进程回收 |
| `cua-helper-host.js` | Helper 生命周期、安装根解析、候选路径、MCP 注入 |
| `cua-ax-roles.js` | AX role→kind 映射与只读方法集 |
| `frame-contract.js` | 官方 CUA 帧完整性契约 |
| `pip-session-node.js` | PIP 会话客户端 |
| `request-access-contract.js` | 访问申请状态契约 |

### 3.2 `vendor/zcode-cua-helper` 原生 Helper

从官方 Windows 安装包 `resources/tools/cua-helper/` 逐字节提取：

```
vendor/zcode-cua-helper/
├── dist/windows-helper.js        entry  (sha256 88b7e601…196e)
├── build/Release/ax_native.node  addon  (sha256 d6c96841…f644, PE 0x8664)
├── node_modules/                 express 5.2.1 + sharp 0.34.5 依赖闭包（69 个包）
├── runtime-manifest.json         官方随包自述：entry/addon/版本/架构/哈希
└── package.json                  producer 契约 zcodeCuaRuntime.schema=1
```

**来源可复验**：官方安装包内 `resources/tools/cua-helper/runtime-manifest.json` 原文即
`packageName: @zcode/zcode-cua`、`packageVersion: 0.6.3`、`platform: win32`、`arch: x64`，
两个哈希与本仓库 vendor 内容完全一致。

### 3.3 构建接线

| 位置 | 改动 | 目的 |
|---|---|---|
| `packages/zcode-cua/package.json` | 删除 `zcodeCuaPlaceholder`，加 `zcodeCuaRuntime` 契约与 `sharp` 依赖 | 让 producer 判定为「真实」 |
| `prepare-windows-cua-helper.mjs` | 默认来源指向 `vendor/zcode-cua-helper` | 让 Helper 暂存能找到产物 |
| `.gitignore` | 逐层否定 `vendor/` | 让二进制产物能入库 |
| `.gitattributes` | `vendor/** -text binary` | 防止 CRLF 破坏哈希与 `.node` |
| `.oxlintrc.json` | `ignorePatterns` 加 `vendor` | vendor 是第三方成品，不套本仓库 lint |
| `scripts/verify-computer-use-restoration.mjs` | 新增门禁 | CI 拦住契约缺失/占位回归/vendor 漂移 |

### 3.4 还原后自动生效的下游行为

producer 判定翻转为 true 后，上游这些**原本被跳过**的步骤会自动启用（无需额外改动）：

- `prepare:runtime-assets` → 增加 `prepare:windows-cua-helper`
- `electron-builder` → `extraResources` 打包 `tools/cua-helper`（主树 + node_modules 分开映射）
- `electron-builder` → `afterPack` 的 `finalizePackagedWindowsCuaHelper` 闭环校验
- `prepare:agent-bundle` → 向 `zcode-cua-plugin` 暂存 sharp 原生依赖
- `afterPack` → `assertPackagedCuaSharp` 校验两个插件的 sharp 树

## 四、怎么复验

```bash
# 1. 契约 + 占位 + vendor 哈希/PE 三门禁（CI 第一站）
node scripts/verify-computer-use-restoration.mjs

# 2. 单独跑 Helper 暂存，日志会打印 manifest 与 PE 架构
pnpm --filter @zcode/desktop prepare:windows-cua-helper
# -> [prepare-windows-cua-helper] staged 0.6.3 win32/x64 PE=0x8664 -> .../cua-helper

# 3. 确认 producer 判定已翻转
node --input-type=module -e "
const m = await import('./packages/desktop/scripts/computer-use-producer.mjs');
console.log(m.isRealComputerUseProducerInstalled({
  desktopPackageRoot: new URL('./packages/desktop', import.meta.url).pathname
}));"
# -> true

# 4. 确认 vendor 产物与官方 manifest 一致
node -e "
const fs=require('fs'),c=require('crypto');
const j=JSON.parse(fs.readFileSync('vendor/zcode-cua-helper/runtime-manifest.json','utf8'));
for (const k of ['entry','addon']) {
  const h=c.createHash('sha256').update(fs.readFileSync('vendor/zcode-cua-helper/'+j[k])).digest('hex');
  console.log(k, h===j.sha256[k] ? 'OK' : 'MISMATCH');
}"
# -> entry OK / addon OK
```

## 五、诚实说明边界

- **`ax_native.node` 是官方编译的二进制，不是本仓库从源码构建的。** 上游没有提供该原生
  addon 的源码（它属于闭源 producer）。本仓库做的是「按官方 manifest 逐字节还原 + 哈希锁定」，
  不是「重写原生实现」。因此它是 vendored binary，不是可审计源码。
- **只还原了 Windows x64。** 官方包的 `cua-helper` 只含 win32-x64 产物；macOS 侧的 Helper 是
  `.app` 形态、由闭源 producer 产出，本仓库不含。macOS 构建仍会走上游的「无真实 producer」路径
  （fail-closed），这是已知限制。
- **`packages/zcode-cua` 的实现体是按契约与运行时行为还原的**，与闭源原实现不保证逐行一致。
  验证手段是：契约导出面齐全（CI 门禁）+ 工具名与插件侧一致 + 真实 Helper 可联通。
- **上游对 Computer Use 的「默认关闭」产品决策未改动**：仍需要用户在设置页显式开启。

## 六、许可与归属

- `packages/zcode-cua/**`：Apache-2.0（沿用上游包声明）。
- `vendor/zcode-cua-helper/**`：来自官方 ZCode 发行版，版权归 Z.ai，**仅供个人/教育/非商业
  使用**。该目录已在 `.gitattributes` 标记 `linguist-vendored`，在 `NOTICE.md` 单独声明。
  若要商用，请先取得 Z.ai 书面许可。
- 本仓库对上游源码的改动不改变上游 `LICENSE`（Apache-2.0）与 `NOTICE.md` 的归属声明。
