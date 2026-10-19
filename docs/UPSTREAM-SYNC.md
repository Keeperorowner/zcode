# 与上游 zai-org/ZCode 同步指南

本仓库是上游 `zai-org/ZCode` 的下游 fork。基底跟踪上游 `main`，本地增补（补齐 Computer Use
运行时、任意消息级回滚、云端构建）以最小侵入的方式叠加。

## 仓库布局

- `main` —— 上游基线 + 本仓库增补，**每次同步上游后在这里解决冲突并跑门禁**
- remote `upstream` → `https://github.com/zai-org/ZCode.git`（官方）
- remote `target` → `https://github.com/Keeperorowner/zcode.git`（本仓库）

本仓库的提交历史保持「上游提交原样 + 少量本地提交」的形状，方便 `git log upstream/main..HEAD`
一眼看清本地增补。

## 日常同步

```bash
git fetch upstream
git rebase upstream/main
```

上游是周期性代码投放仓库（创建于 2026-09-20），同步频率低，但单次同步的改动量可能很大
（v3.15.1 → v3.16.1 一次就有 4502 个文件、+35.6 万 / -12.2 万行）。因此冲突面**不能**按
「上游提交少」来估计，必须逐文件核对。

## 本仓库的增补面

| 增补 | 触及面 | 冲突风险 |
| --- | --- | --- |
| Computer Use 运行时还原 | `packages/zcode-cua/`、`vendor/zcode-cua-helper/`、`.gitattributes` | 低（上游基本不碰 `packages/zcode-cua` 的实现体） |
| 任意消息级回滚 | 协议 + 投影 + UI + core 运行时 | 中（`turn.ts` / `SessionPane.tsx` / `product-projection.ts` 上游改动大） |
| 云端构建 | `.github/workflows/build.yml` | 无（上游无 workflow） |

## 冲突原则

增补代码的写法约束（违反会放大未来冲突）：

1. 协议新增键一律加在 schema 对象**末尾**
2. handler 单独成文件，不并入上游既有文件的大函数体
3. UI 改动使用独立的条件分支/props，不重排上游代码行序
4. 投影（`product-projection.ts`）是少数需要在上游函数体内加行的文件，
   每处增补用 `// zcode-oss: begin/end` 标记块包裹
5. **不改动上游 core 原语**：`packages/zcode-cli/packages/core/src/runtime/methods/rewind-message.ts`
   的回滚原语（`rewindToMessage` / `rewindCascadeToMessage` / `rewindConversationToMessage` /
   `rewindWorkspaceToMessage`）在本仓库中原样保留，只把它的一个内部函数改为 `export`

## 标记约定

所有本仓库增补代码统一使用标记注释，便于同步时快速定位与回溯：

```ts
// zcode-oss: begin message-rewind (docs/design/message-rewind.md)
...增补代码...
// zcode-oss: end
```

## 同步后的必跑门禁

```bash
node scripts/verify-computer-use-restoration.mjs   # CUA 还原门禁
pnpm typecheck
pnpm lint
node apps/zcode-cli/../../node_modules/vitest/vitest.mjs run --root apps/zcode-cli \
  packages/core/tests/message-rewind-snapshot.test.ts \
  packages/core/tests/message-rewind-revert.test.ts
```

云端构建由 `.github/workflows/build.yml` 在 push 到 `main` 时自动触发。

## 已知的同步陷阱

- **3-way 合并不冲突但会编译失败**：上游新增了对某个 import 的使用，而基于旧版本的本地补丁
  删除了该 import 时，合并不会报冲突，但类型检查会报 `TS2304: Cannot find name ...`。
  v3.15.1 → v3.16.1 同步时本仓库就踩到过
  （`packages/services/src/zcode-agent/zcodeAgentService.ts` 的 `createHash`）。
  **同步后必须跑完整 typecheck，不能只看合并有没有冲突。**
- **字符串前缀陷阱**：本仓库的标记前缀是 `zcode-oss`，与上游标识 `zcode-protocol` 无重叠。
  批量替换 fork 品牌名时务必用负向前瞻（`/zcode-pro(?!tocol)/`），否则会把
  `zcode-protocol-v4` 一起改坏。
