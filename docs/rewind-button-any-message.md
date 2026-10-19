# 消息级撤销入口下线

> 本文件在fork中同时记录两件事：上游为什么下线该入口，以及本仓库为什么重新接上它。
> 上游事实以 `## 上游背景` 为准；本仓库的处置以 `## 本仓库处置` 为准。

## 本仓库处置

本仓库**重新启用**了消息级回滚入口，并新增了 redo（撤销回滚）能力：

| 能力 | 命令 | 说明 |
| --- | --- | --- |
| 对话级回滚 | `rewindConversation` | 截断任意历史 user 消息及其之后的对话分支，不重发输入 |
| 对话 + 文件回滚 | `rewindConversation`（`workspaceMode: "rewind"`） | 先把工作区整树恢复到该轮开始前，再截断对话 |
| 撤销回滚（redo） | `unrewindConversation` | 恢复最近一次回滚的全部效果（消息分支 + 文件） |

实现与设计见 [design/message-rewind.md](design/message-rewind.md)。回归覆盖见
`apps/zcode-cli/packages/core/tests/message-rewind-*.test.ts` 与 `scripts/e2e-rewind.mjs`。

与上游的差异（都是**加法**，不改上游既有键的结构）：

- `packages/shared/src/zcode-protocol-v4/rows.ts`：`actions` 增加可选键 `canRewind`。
  上游的 `canEdit` / `canRetry` / `canFork` / `canRewindFiles` 语义原样保留。
- `packages/shared/src/zcode-protocol-v4/command.ts`：新增 `rewindConversation` /
  `unrewindConversation` 两个命令 payload；`editUserQuery` 的 latest-only 守卫不变。
- `apps/zcode-cli/packages/core/src/runtime/methods/rewind-message.ts`：
  仅把既有的 `rebuildConversationDerivedState` 改为 `export`（供 redo 复用），逻辑零改动。

上游的 core 原语（`rewindToMessage` / `rewindCascadeToMessage` /
`rewindConversationToMessage` / `rewindWorkspaceToMessage`）**本仓库完全复用，未做修改**；
本仓库新增的只是产品接线层（协议命令 + 投影 + UI 入口）与 Phase 2/3 的文件快照与 redo。

## 上游背景

### 当前状态

消息卡片 footer 中的消息级“撤销”入口已下线，不再在用户消息或助手消息下方展示。V4 不存在 conversation cascade rewind 命令。

本次下线针对的是聊天消息级 cascade rewind 入口，不影响 `MessageChangeSummaryPanel` 中基于文件变更摘要的“撤销 / 重新应用”能力。文件级入口仍用于切换某个 assistant turn 的 workspace 文件状态。

### 背景

该入口最早由以下提交引入：

| commit | 作者 | 时间 | 标题 |
| --- | --- | --- | --- |
| `a9e3ace78` | — | `2026-06-24 18:20:03 +0800` | `feat(ui): support message-level rewind with preview confirmation` |

后续同一功能还有多笔修复提交，例如 `ab1a92254`、`daed7eb81`、`51889364a`、`fc764779b`。当前产品语义决定先移除 UI 入口，避免用户把“消息历史回退 + 文件回退”和文件摘要里的单 turn 文件切换混在一起。

### 约束

- V4 `ConversationRowView` 不提供 conversation rewind action。
- 独立 `session/rewind` / `session/rewindCascade` 已从协议和调用链删除。
- 修改历史 query 使用 `editUserQuery`；重试使用 `retryTurn`。
- 文件状态回退使用 `applyFileRewind`，不会隐式截断聊天历史。

### 验证重点

- 消息 actions 只保留当前 row projection 允许的 copy、edit、retry、fork 等动作。
- 文件变更摘要面板仍可按原语义触发文件级撤销 / 重新应用。
- 手机远控不新增任何 replayable rewind 入口。

## 本仓库的验证重点

在上述之上，额外需要保证：

- 消息行只在 `row.actions.canRewind === true` 时展示回滚入口（投影层裁决，UI 不自行判断）。
- 协议新增命令必须登记在 `COMMANDS_REQUIRING_BASE_REVISION`（CAS 同档）与
  `ROW_TARGETING_COMMANDS`（行目标解析）里，否则命令信封缺 revision 校验。
- 回滚是**分支软删除**：`sessionStore.setRevert` 写 `keptMessageIDs` 前缀，消息 append-only
  不物理删除，fork / 审计仍可追溯。
- 工作区恢复失败时**不截断对话**（fail-closed）；对话截断失败但文件已恢复时，用撤销点
  捕获的 pre-undo 整树反向恢复文件，避免留下半程状态。
- redo 窗口在**新 prompt 开始时**作废（CLI 侧 `clearRewindUndoJournal`，UI 侧横幅收起）。
- 手机远控链路（`web-remote-replayable`）不新增任何 rewind 入口。
