# 运行状态投影与控制语义

状态：进行中，2026-10-29。先在 Pie 完成共享实现与验证；Cloud 暂不修改，后续按共享包差量同步，不覆盖宿主已有改动。

## 问题与目标

`Turn.status` 只描述回合生命周期，不能单独回答“模型是否仍在输出、哪些工具仍在执行、是否等待确认、取消是否仅已请求”。例如流式工具已启动而模型仍在输出，两种工作同时存在；取消接口返回也不代表工具副作用已撤销。宿主不应从最后一条文本、连接状态或一个 busy 标志猜测结果。

借鉴 ZCode 的分轴状态与权威投影，不复制其产品状态机。Pie 负责执行事实；Astron / Cloud 负责用户权限、连接、产品状态及展示。沿用 [统一 Loop](remote-loop-evolution.md)、[事件流](session-event-stream.md)、[Turn 恢复](turn-recovery.md) 与 [流式工具](streamed-tool-execution.md) 的现有边界。

## 范围与约束

- 保留 `running / interrupted / completed / cancelled / failed` 原始 Turn 状态。没有终态、未知外部结果和取消请求都不能投影成成功；`turn.settled` 不等于 `completed`。
- 共享轻量 `execution` 摘要：模型流、活动工具、等待交互、取消请求、已知恢复阻断原因。模型与工具允许同时活动，不压成互斥 phase；工具离开活动集合只表示本实例不再执行，不证明外部副作用成功、失败或已撤销。
- 快照、会话增量和全局事件使用同一个投影。沿用 instanceId / revision 的旧包丢弃、缺口及实例变化重建，不增加事件重放、独立状态持久化或历史扫描。
- 复用 requestId / clientMessageId / Turn 身份与现有持久化路径，不新增 CommandInbox、任务队列或另一套执行账本。运行摘要不携带历史、完整 assistant partial 或 ToolExecution 账本。
- 操作可用性只描述 Runtime 约束，宿主仍须叠加租户与产品授权；resume 必须重新核对历史、checkpoint、账本和外部结果，不能从 interrupted 推断可安全恢复。
- 不修改 Cloud、Astron 适配器、Amio 或公共 AgentCore 协议，不部署 Sidecar。完成 Pie 后再同步共享包，云端业务接入与生产验收单独进行。

## 实施顺序与验收

1. **运行摘要与事件一致性（已完成）**：新增 `SessionExecution`；`SessionSnapshot.execution` 必填，会话增量可携带 execution 更新，全局事件携带同源摘要。取消请求发出状态变化，回合结算后清除瞬时活动；重启只从当前事实重建，不复活旧工具或交互 Promise。覆盖模型 / 工具重叠、并行工具、等待确认、取消未结算、各类 Turn 终态、事件合并及重连；常规投影不得读历史或账本。
2. **输入与控制回执（本阶段）**：基于现有身份明确 accepted / started / settled，以及 cancellation requested / turn settled；重试去重沿用当前持久 Turn 的 `requestId`，不新增 CommandInbox。新增输入在成功持久化后返回，steer 只承诺已进入当前进程队列，不承诺未持久化队列的 crash-safe 重放。
3. **操作可用性（本阶段）**：在 `execution.actions` 投影 `submit / steer / cancel / resume` 的 Runtime 约束和稳定 reason code；宿主仍须叠加租户与产品授权，且命令执行时再次校验。`resume.available` 只表示进入恢复核对的边界，不代表历史、账本或外部任务一定通过。
4. **共享包同步与宿主验收（Pie 完成后）**：差量同步，不重写 Cloud 业务；检查宿主不会把 interrupted 或未知状态兜底为成功，补充断连、恢复及取消的联合验收。此项不能由 Pie 本地测试替代。

每阶段先运行定向 Node 测试，再运行 `npm run test:runtime`、`npm run test:server` 和 `npm run check`。不调用付费模型、不执行 build；验收记录只登记实际运行的结果。

## 实施记录

- 阶段 1：已完成 Pie 侧实现与本地验收。
  - `packages/runtime/src/protocol.ts` 定义必填的 `SessionSnapshot.execution`；`runtime.ts` 用当前模型边界、活动工具集合、待确认请求和 checkpoint 投影，不读历史或账本，不保存第二份运行状态。
  - `modelStreaming` 独立于 `streamingMessage`：工具先完成并写入结果时，尚未结束的模型流仍为活动。`activeTools` 只含当前实例的工具调用 ID / 名称，允许多工具与模型流同时存在。
  - `waitingForInteraction` 表示本会话拥有待回答请求（包括转交父会话的子任务确认），不表示所有并发工作都已暂停。`cancellationRequested` 仅在 running Turn 期间表示停止请求，最终结果仍读取 Turn；结算后归零，不替代持久取消事实。
  - `recoveryBlockedReason` 只在 interrupted 时暴露 checkpoint 已知的阻断原因；没有此字段不等于允许 resume。中断原因继续由 `Turn.error` 表达，外部未知结果继续查询独立执行账本。
  - `session-events.ts` 合并摘要增量；快照、会话事件及全局事件使用同一投影。原始 Turn 状态不被重新分类；实例变化、版本缺口与旧事件仍沿用现有重建规则。
  - 新增 `packages/server/test/execution-state.test.ts` 并纳入 `test:server`，补充事件合并测试，更新 Web 测试快照及 Runtime changelog。没有修改存储 schema、模型 / 工具执行协议或 Cloud。
  - 验证：定向 Node 测试 13/13；`npm run test:runtime` 59/59；`npm run test:server` 241/241；`npm run check` 全部通过，Biome 未额外修改文件。测试覆盖模型 / 工具重叠及工具先结束、多工具并行、确认等待、取消已返回但工具未结算、原始终态、重新激活与事件投影一致性；常规投影没有新增历史或账本读取。
  - 验证边界：共享协议与事件边界使用假模型、受控工具及真实 SQLite 回归；未调用付费模型、未运行 build、未部署 Sidecar、未验证宿主 UI。阶段 1 没有偏离范围，不把后续回执或操作可用性标为完成。
- 阶段 2：已完成 Pie 侧实现与本地验收。
  - `protocol.ts` 新增 `TurnReceipt / CancellationReceipt / SteerReceipt`；`runtime.ts` 在提交、恢复、steer 和取消入口返回明确回执，不把受理或取消请求当成完成。
  - 当前 Turn 保存原始 `rootRequestId`，保留 steer 更新的最近 `requestId`；相同原始或最近 ID 重试返回现有 Turn，不追加用户消息或再次启动。范围仅限当前 Turn，不新增跨 Turn 收件箱；steer 队列仍不承诺崩溃重放。
  - `runtime.test.ts` 覆盖受理、启动、排队、取消、结算和 steer 后原始请求重试；嵌入文档与 Runtime changelog 同步说明。
  - 验证：定向 Node 测试 46/46、`npm run test:core` 71/71；本轮追加回执、重试去重及操作可用性测试，`npm run test:runtime` 60/60、`npm run test:server` 252/252、`npm run check` 全部通过。
  - 未调用付费模型，未修改 Cloud / Astron、未构建或部署；阶段 3 已在 Pie 侧完成。
- 阶段 3：已完成 Pie 侧实现与本地验收。
  - `execution.actions` 暴露四个 Runtime 操作的可请求条件和稳定原因码；`resume.available` 只代表进入恢复核对边界，不替代历史、账本和外部任务校验。
  - `packages/server` 的全局事件快照同步携带 `execution`，使云端或宿主可读取同一操作可用性投影；未新增宿主权限判断。
  - 验证：`npm run test:runtime` 60/60、`npm run test:server` 252/252、`npm run check` 全部通过；未修改 Cloud / Astron，未构建或部署。
- 阶段 4：未开始。Cloud 保持不动。
