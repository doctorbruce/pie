# 运行状态投影与控制语义

状态：已完成 Pie 侧阶段 1–3 与边界收口，2026-10-29。阶段 4 未开始，不在本次范围。

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
2. **输入与控制回执（已完成）**：基于现有身份明确 accepted / started / settled，以及 cancellation requested / turn settled；重试去重沿用当前持久 Turn 的 `requestId`，不新增 CommandInbox。新增输入在成功持久化后返回，steer 只承诺已进入当前进程队列，不承诺未持久化队列的 crash-safe 重放。
3. **操作可用性（已完成）**：在 `execution.actions` 投影 `submit / steer / cancel / resume` 的 Runtime 约束和稳定 reason code；宿主仍须叠加租户与产品授权，且命令执行时再次校验。`resume.available` 只表示进入恢复核对的边界，不代表历史、账本或外部任务一定通过。
4. **共享包同步与宿主验收（未开始，本次范围外）**：差量同步，不重写 Cloud 业务；检查宿主不会把 interrupted 或未知状态兜底为成功，补充断连、恢复及取消的联合验收。此项不能由 Pie 本地测试替代。

每阶段先运行定向 Node 测试，再运行 `npm run test:runtime`、`npm run test:server` 和 `npm run check`。不调用付费模型、不执行 build；验收记录只登记实际运行的结果。

## 实施记录

以下为此前阶段的验收记录；本次边界收口与重新验收见文末行动日志。

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

## Pie 边界收口行动日志（ub-mode）

### First Make it Work

- 核对 `6f72548c0` 上的 SPEC、嵌入与开发文档，完整阅读相关实现及测试。用 `npm install --ignore-scripts` 补齐 workspace 依赖，依赖声明和锁文件无变化。
- 恢复被忽略的模型数据以运行真实 Local / HTTP 测试：常规 hydrate 因公开目录重命名 Kimi provider 失败，临时映射后生成的最新目录又与当前测试引用不匹配；最终使用官方 npm 同版本 `0.85.1` 数据，按本仓库现有生成规则修正 Copilot GPT 的 Responses 分组并重建 manifest。校验通过，未改 AI 源码或测试。临时下载与脚本已清理。
- 先新增回归并确认预期失败：两种取消 / steer 窗口均错误接纳；Local 取消未立即传递 AbortSignal；HTTP 全局流丢 revision。随后最小修改 `packages/runtime/src/runtime.ts`、`packages/local/src/runtime.ts`、`packages/server/src/server.ts`，分别复用准入投影、直接转交取消、持续转发同源摘要。

### Then Make it Right

- `steer` 在入口及持久化 / Agent 装载后复用 `actionAvailability` 校验，覆盖 `cancelRequested / cancelPromise`；已拒绝输入不写队列 checkpoint，取消前排队和取消后迟到的输入均不进入下一 Turn。
- Local 直达路径仍核对关闭状态，Runtime 继续校验 Turn 身份、持久化取消意图并维持关闭 / 下一 Turn 屏障。回归覆盖错误 Turn ID 不取消、取消先于排队读取到达、关闭后拒绝取消和最终结算。
- HTTP 每个全局包携带 `instanceId / revision / execution`，不因内容事件不可公开而丢状态；交互请求、交互结束和活动更新均保留。会话 SSE 启动包也带顶层 execution，不扩大历史或 assistant partial 载荷。
- 新增真实 HTTP / SSE 回归，覆盖批准确认后取消、等待确认时直接取消；对照空闲、等待中与结算后的 HTTP 快照、SSE 启动 / 重连及会话 / 全局流。模型结束可能在交互请求后继续推进 revision，因此按同一 revision 比较，不假设网络接收时间一致。现有无历史扫描、活动重叠和并行工具测试保持通过。
- 环境未提供 crapper / dryer / mutator；人工检查新增函数的分支和重复，未新增独立状态或另一套准入规则。用临时脚本逐项撤掉入口校验、异步后校验、全局 execution、交互结束转发、Local 直达取消，5/5 均被对应断言检出。脚本恢复定位曾不唯一，改为核对文件未被并发修改后恢复原文；最终源码已核对恢复，未宣称运行了缺失工具或取得其评分。

### Follow Practice

- 定向验证：`node --conditions=source --test packages/server/test/global-stream.test.ts packages/server/test/execution-state.test.ts packages/runtime/test/runtime.test.ts` 首轮 39/39；补充断言后的 steer 定向 2/2，最终 global-stream 文件 4/4。共新增 5 项回归，全部纳入根测试脚本。
- 完整验收：`npm run test:runtime` 62/62，`npm run test:server` 257/257；`npm run check` 通过（Biome 450 文件无额外修改，根与 Web 类型检查、模型数据校验通过）；`git diff --check` 通过。
- 同步本 SPEC、`docs/agent-development.md`、`docs/runtime-embedding.md`、Server README 及 Runtime / Server changelog。保留全部未提交改动供审阅，未 commit；未修改 `/workspace/refs`，未调用付费模型，未 build 或部署，未开始阶段 4。Pie 侧无遗留待办；缺失分析工具的替代验证与模型数据环境恢复是本轮执行方式的偏差。
