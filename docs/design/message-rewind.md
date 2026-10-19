# 设计文档：任意消息级回滚（Message Rewind）

> 状态：Phase 1 / 2 / 3 全部落地 · 基线：上游 v3.16.1
> 上游的产品裁决与本仓库的分歧见 [../rewind-button-any-message.md](../rewind-button-any-message.md)。

## 1. 背景与参照

### 1.1 上游现状（zai-org/ZCode v3.16.1）

core runtime 已具备任意消息回滚原语，但 v4 产品协议收紧入口：

| 层 | 位置 | 现状 |
| --- | --- | --- |
| 原语 | `apps/zcode-cli/packages/core/src/runtime/methods/rewind-message.ts` | `rewindToMessage(scope: Conversation\|Workspace\|Both)` 支持任意 active-chain 消息；另有 `rewindCascadeToMessage`（跨多个 checkpoint 级联） |
| 投影 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts` | 仅最后一条可编辑 user 行获得 `canEdit` |
| 载荷 | `packages/shared/src/zcode-protocol-v4/rows.ts` | `actions` 无 `canRewind` 键（裁决注释明示） |
| 命令面 | `packages/shared/src/zcode-protocol-v4/command.ts` | 只有 `editUserQuery` / `applyFileRewind`，无独立 rewind 命令 |

"无法回到任意对话原点"的直接原因即上表后三行——原语一跳之遥。**本仓库不改原语，只补后三行。**


### 1.2 参照实现（Kilo Code，opencode 架构）

Kilo 的 snapshot 系统（`packages/opencode/src/snapshot/index.ts`，256 行）要点：

- **影子 git**：`git --git-dir $XDG_DATA/kilo/snapshot/<projectID> --work-tree <工作区>`，
  快照 = `git add . && git write-tree` 的 tree 对象（无 commit 历史，内容寻址）
- **触发**：每个 LLM step 边界（工具执行前后）成对 `track()`，step 结束时算出
  patch part `{hash, files[]}` 挂在消息数据上
- **两阶段 revert**：先拍当前快照（供 redo）→ 逐 patch `git checkout <hash> -- file`
  恢复、新建文件 `unlink` → 对话仅打标记，下一条 prompt 时才惰性截断
- **redo**：`unrevert` 用预留快照整树还原（`read-tree + checkout-index`），消息未真删自动回归
- **入口**：`POST /session/:id/revert|unrevert`，TUI `/undo` `/redo`
- 零 VS Code 依赖，仅需系统 git + 项目本身是 git 仓库
- 已知取舍：gitignore 文件不进快照；只删文件不删空目录；unicode 内容恢复有已知问题

### 1.3 上游内部已有但未接线的资产

`packages/services/src/git/` 下有完整 shadow git 快照服务
（`gitCheckpointService.ts` + `repo/gitCheckpointRepo.ts:240-357`）：

- 临时 `GIT_INDEX_FILE`（复制用户 index 预热）→ `git add -A` → `write-tree` →
  `commit-tree` → hidden ref `refs/zcode/checkpoints/<workspaceHash>/<id>` 防回收
- restore 走三方比较（from/to/现实）+ 冲突检测 + `git restore --source=<oid>`，
  只动 worktree 不动用户 index
- RPC channel `"git-checkpoint"` 已注册（`packages/shared/src/channels.ts:83`），
  renderer 经 `ProxyChannel` 一行可达，但**全仓库零调用方**

Phase 2 将其实现模式移植进 agent core（非直接调用桌面侧服务，理由见 §4）。

## 2. Phase 1 设计：任意消息对话回滚

### 2.1 命令链路（复用 editUserQuery 管道）

```
ConversationRowView (hover 按钮，条件 row.actions?.canRewind === true)
  → ConversationTurnGroup 条件透传 onRewind
  → SessionPane.handleRewind → dispatchCommand("rewindConversation", {target, workspaceMode})
       （CAS 信封：baseRevision / baseLogEpoch，与 handleEdit 同构）
  → agentConversationTransport.sendCommand (能力握手后发送)
  → [MessagePort → 桌面 host → stdio JSON-RPC]
  → v4-gateway.handleCommand（六态裁决/CAS）
  → handlers/rewind-conversation.ts
       → host.resolveRowActionTarget(sessionId, target, "rewindConversation")
       → record.app.runtime.rewindConversationToMessage({ targetMessageId, ... })
            （core 零改动；branch cut + row.removed 自动驱动 GUI 截断）
```

### 2.2 协议层改动（纯加法）

`packages/shared/src/zcode-protocol-v4/rows.ts`：

```ts
actions: z.object({
  canFork: z.literal(true).optional(),
  canEdit: z.literal(true).optional(),
  canRetry: z.literal(true).optional(),
  canRewindFiles: z.literal(true).optional(),
  canRewind: z.literal(true).optional(),   // ← 新增
  editDisposition: z.enum(["rewind", "fork"]).optional(),
}).optional(),
```

`packages/shared/src/zcode-protocol-v4/command.ts`：

- `commandPayloadSchemas` 新增 `rewindConversation: z.object({ target, workspaceMode? })`
- `COMMANDS_REQUIRING_BASE_REVISION`、`ROW_TARGETING_COMMANDS` 各登记一项
- ACK 结果联合加分支

旧客户端剥离未知键 → 向后安全。

### 2.3 agent 层改动

- `product-projection.ts :: materializeCommandRowActions`：userInput 分支为所有
  active-chain `origin === "realUser"` 且有 editTarget 登记的行设 `canRewind = true`
  （**不**要求 latest-only）
- `resolveRowActionTarget`：新增 `"rewindConversation"` 动作分支，复用
  `resolveEditTargetByEntityId` 的登记查询，跳过 latest 校验
- 新 handler `commands/handlers/rewind-conversation.ts`：
  - `workspaceMode = "preserve"`（Phase 1 默认）：直接
    `rewindConversationToMessage({ targetMessageId })`
  - `workspaceMode = "rewind"`（Phase 2 后启用）：照抄 fork-edit-retry.ts:150-205
    的 preview → fail-closed → `applyWorkspaceFileRewind({ commitAfterApply })` 组合
  - turn 运行中先拒绝（对齐现有 `canRewindFiles` 的 gating）

### 2.4 UI 层改动

- `ConversationRowView.tsx`：user 行 MessageActions 新增回滚图标按钮 +
  `onRewind?: (target) => void` prop
- `ConversationTurnRow.tsx`：props 透传
- `ConversationTurnGroup.tsx`（两处 user 行渲染点）：`onRewind={row.actions?.canRewind === true ? onRewind : undefined}`
- `SessionPane.tsx`：`handleRewind`（模仿 handleFork :3023-3046）+ 传参
- `ConversationFileRewindDialog.tsx`：新增 variant 复用为确认弹窗
- i18n：`zh-CN` / `en-US` 文案

### 2.5 GUI 刷新（免费获得）

core 落 `SessionEventType.RewindTriggered` → 投影 `onRewindTriggered`
（`product-projection.ts:1762-1828`）发 `row.removed {fromRowId}` → 前端
`conversationProjectionStore` 自动截断。被回滚消息直接消失；冷恢复按 branch cut
后的分支重建。**无需任何额外 UI 刷新代码。**

## 3. 数据与一致性要点

- **CAS**：命令信封带 `baseRevision` / `baseLogEpoch`，六态 inbox 裁决防并发窗口
- **branch cut 软删除**：`sessionStore.setRevert()` 写 `keptMessageIDs` 前缀，
  消息 append-only 不物理删除 → fork/审计仍可追溯
- **fail-closed 保留**：`workspaceMode="rewind"` 沿用 safe/unsafe/ignored 预检，
  证明不了完整回滚就不执行（bash 副作用在 Phase 2 前一律走 preserve 或拒绝）

## 4. Phase 2 关键决策：快照放 agent 侧，不放桌面侧

| | agent 侧（选定） | 桌面侧 gitCheckpointService（否决） |
| --- | --- | --- |
| 事务边界 | 单进程闭合：停后台任务 → 恢复文件 → commit gate 内提交 branch cut | 两进程两步，无原子序 |
| 时机精度 | TurnStarted/TurnComplete 同步可见，工具批次间隙保证空闲 | 从投影帧反推，turn 起点有部分写入竞态 |
| 一致性 | 与 `readFileState` / hash 校验同一事实源 | `external_modified` 误报 |
| 远端 workspace | 同机执行 | 需 remote proxy 多一跳 |

移植方式：把 `gitCheckpointRepo` 的临时 index + hidden ref 模式改写为 core 的
checkpoint 后端（core 为零生产依赖的 Node 内建栈，不能直接 import services 包），
与 `CheckpointCreated` 事件 / `workspace-checkpoints.ts` 选择器并轨。

## 5. 风险清单

1. **产品裁决**：上游注释明示"rewind 不做独立命令"。回流 PR 需论证场景；
   本项目作为下游 fork 不受约束。
2. **e2e 黄金测试**：新增命令不进既有用例；新增用例覆盖 preserve 模式。
3. **协议演进**：`canRewind` 为 optional literal true，旧客户端剥离未知键，
   与上游 vNext 兼容面良好。
4. **zod schema 冻结面**：新 payload 走新增键，不改既有键结构。

## 6. 本仓库的落地状态

### 6.1 文件清单

新增（第一方源码）：

| 文件 | 作用 |
| --- | --- |
| `apps/zcode-cli/packages/core/src/runtime/methods/turn-workspace-snapshot.ts` | Phase 2：turn 起点全量快照（shadow git） |
| `apps/zcode-cli/packages/core/src/runtime/methods/rewind-revert.ts` | Phase 3：redo（撤销回滚）与 undo journal |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/rewind-conversation.ts` | v4 命令 `rewindConversation` |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/unrewind-conversation.ts` | v4 命令 `unrewindConversation`（redo） |
| `apps/zcode-cli/packages/core/tests/message-rewind-snapshot.test.ts` | 快照/整树恢复的单测 |
| `apps/zcode-cli/packages/core/tests/message-rewind-revert.test.ts` | undo journal 与 redo 三道拒绝闸的单测 |
| `scripts/e2e-rewind.mjs` | 无头 e2e（多级 undo → redo 回归；**需要真实模型 API，只能手动跑**） |

修改（全部为加法，上游既有逻辑零改动）：

| 文件 | 改动 |
| --- | --- |
| `packages/shared/src/zcode-protocol-v4/rows.ts` | `actions` 增加可选键 `canRewind` |
| `packages/shared/src/zcode-protocol-v4/command.ts` | 新增两个命令 payload + CAS / 行目标登记 + ACK 联合分支 |
| `apps/zcode-cli/packages/contracts/src/rewind/index.ts` | 新增 `RewindRevertedPayload` |
| `apps/zcode-cli/packages/contracts/src/events/session.events.ts` | 新增 `SessionEventType.RewindReverted` |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts` | `materializeCommandRowActions` 下发 `canRewind`；`resolveRowActionTarget` 增加 `rewindConversation` 分支（绕过 latest-only 闸） |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cold-event-merge.ts` | 冷合并抑制被 redo 撤销的 `RewindTriggered` |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts` | 新增 `forceConversationProjectionRehydrate`（redo 后强制投影重建） |
| `apps/zcode-cli/packages/core/src/runtime/methods/rewind-message.ts` | 仅把 `rebuildConversationDerivedState` 改为 `export` |
| `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts`、`steering.ts` | turn 起点挂钩：拍快照 + 作废 redo 窗口（含排队 drain 轮次） |
| `packages/ui/src/v4/ConversationRowView.tsx`、`SessionPane.tsx`、`conversationRowContext.ts` | 消息行回滚按钮、redo 横幅、被撤销提问回填输入框 |

### 6.2 移植到 v3.16.1 时的两处手工合并

上游 v3.15.1 → v3.16.1 期间 `turn.ts`（+352 行）与 `SessionPane.tsx`（+1404 行）改动很大，
补丁在这两个文件上产生冲突，其余 29 个文件均可 3-way 干净应用：

1. `turn.ts`：上游新增了 `turn-execution-fallback.js` 的 import，与本功能的
   `turn-workspace-snapshot.js` / `rewind-revert.js` import 落在同一处 —— 取并集。
2. `SessionPane.tsx`：上游给 `rowContext` 的能力注入加了 `runtimeReady` 门控
   （runtime 未就绪时不提供文件回滚等能力）。本功能的 `rewindConversation` 同样受
   runtime 就绪约束，沿用同一门控：`runtimeReady ? handleRewindConversation : undefined`。

另有一处**非冲突但会编译失败**的合并副作用：上游 v3.16.1 在
`packages/services/src/zcode-agent/zcodeAgentService.ts` 新增了 `createHash` 的用法，
而基于 v3.15.1 的补丁删除了该 import。移植时必须保留 `createHash`。

### 6.3 与上游同步的注意事项

- 标记约定：所有本仓库增补代码用 `// zcode-oss: begin …` / `// zcode-oss: end` 包裹，
  便于下次同步上游时快速定位。
- 协议新增键一律加在 schema 对象**末尾**；handler 单独成文件，不并入上游既有大函数体；
  UI 改动使用独立条件分支/props，不重排上游代码行序。
- 影子仓 ref 前缀 `refs/zcode-oss/turnsnap` 与上游的 `refs/zcode/checkpoints/...` 不冲突。

