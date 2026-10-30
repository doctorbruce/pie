# 运行状态投影与控制语义

状态：Pie 侧已完成并通过本地验收。阶段 1–3 的版本切面、控制拒绝契约与全局重连基线已收口；阶段 4 未开始，不在本次范围。

## 问题与目标

`Turn.status` 只描述回合生命周期，不能单独回答“模型是否仍在输出、哪些工具仍在执行、是否等待确认、取消是否仅已请求”。例如流式工具已启动而模型仍在输出，两种工作同时存在；取消接口返回也不代表工具副作用已撤销。宿主不应从最后一条文本、连接状态或一个 busy 标志猜测结果。

借鉴 ZCode 的分轴状态与权威投影，不复制其产品状态机。Pie 负责执行事实；Astron / Cloud 负责用户权限、连接、产品状态及展示。沿用 [统一 Loop](remote-loop-evolution.md)、[事件流](session-event-stream.md)、[Turn 恢复](turn-recovery.md) 与 [流式工具](streamed-tool-execution.md) 的现有边界。

## 范围与约束

- 保留 `running / interrupted / completed / cancelled / failed` 原始 Turn 状态。没有终态、未知外部结果和取消请求都不能投影成成功；`turn.settled` 不等于 `completed`。
- 共享轻量 `execution` 摘要：模型流、活动工具、等待交互、取消请求、已知恢复阻断原因。模型与工具允许同时活动，不压成互斥 phase；工具离开活动集合只表示本实例不再执行，不证明外部副作用成功、失败或已撤销。
- 快照、会话增量和全局事件使用同一个投影。沿用 instanceId / revision 的旧包丢弃、缺口及实例变化重建，不增加事件重放、独立状态持久化或历史扫描。
- 复用 requestId / clientMessageId / Turn 身份与现有持久化路径，不新增 CommandInbox、任务队列或另一套执行账本。运行摘要不携带历史、完整 assistant partial 或 ToolExecution 账本。
- 操作可用性只描述 Runtime 约束，宿主仍须叠加租户与产品授权；resume 必须重新核对历史、checkpoint、账本和外部结果，不能从 interrupted 推断可安全恢复。
- 验收以 SDK、HTTP/SSE 和嵌入契约为准，不以自带 UI 为宿主（见 [删除 SPEC](remove-bundled-web.md)）。不修改 Cloud、Astron 适配器、Amio 或公共 AgentCore 协议，不部署 Sidecar。完成 Pie 后再同步共享包，云端业务接入与生产验收单独进行。

## 实施顺序与验收

1. **运行摘要与事件一致性（已完成）**：新增 `SessionExecution`；`SessionSnapshot.execution` 必填，会话增量可携带 execution 更新，全局事件携带同源摘要。取消请求发出状态变化，回合结算后清除瞬时活动；重启只从当前事实重建，不复活旧工具或交互 Promise。覆盖模型 / 工具重叠、并行工具、等待确认、取消未结算、各类 Turn 终态、事件合并及重连；常规投影不得读历史或账本。
2. **输入与控制回执（已完成）**：基于现有身份明确 accepted / started / settled，以及 cancellation requested / turn settled；重试去重沿用当前持久 Turn 的 `requestId`，不新增 CommandInbox。新增输入在成功持久化后返回，steer 只承诺已进入当前进程队列，不承诺未持久化队列的 crash-safe 重放。
3. **操作可用性（已完成）**：在 `execution.actions` 投影 `submit / steer / cancel / resume` 的 Runtime 约束和稳定 reason code；宿主仍须叠加租户与产品授权，且命令执行时再次校验。`resume.available` 只表示进入恢复核对的边界，不代表历史、账本或外部任务一定通过。
4. **共享包同步与宿主验收（未开始，本次范围外）**：差量同步，不重写 Cloud 业务；检查宿主不会把 interrupted 或未知状态兜底为成功，补充断连、恢复及取消的联合验收。此项不能由 Pie 本地测试替代。

每阶段先运行定向 Node 测试，再运行 `npm run test:runtime`、`npm run test:server` 和 `npm run check`。不调用付费模型、不执行 build；验收记录只登记实际运行的结果。

## 实施记录

### 版本与宿主边界收口（ub-mode，已完成）

- First Make it Work：核对当前实现；先用阻塞存储复现工具开始、消息完成、取消及完整历史读取窗口，并验证跨会话写失败的传播。保留同版本同 execution / Turn 的承诺，发布时固定轻量投影及历史叶子，不新增持久状态或重放日志。
- Then Make it Right：四个控制入口复用 `actionAvailability / assertAction`；新操作与当前请求幂等重试、恢复预检、终态取消无操作及显式尽力停止分别定义。`RuntimeError.reason` 贯穿 Local / HTTP；`CancellationReceipt.durable` 区分普通取消与存储故障后的进程内停止。
- 全局重连采用 `subscribeExecutions(sessionIds)` 与 `/events?sessionId=A&sessionId=B`，仅装载 1–200 个指定会话元信息；同步注册、捕获并交付 `execution.baseline`，随后按会话水位对齐。不扫描历史、不积压冷读取期间的内容事件、不持久重放。订阅仅保留轻量元信息，闲置 Agent 仍可卸载；卸载后每个已观察会话只保留一个整数水位，防止旧 revision 复用。
- 没有新增工作摘要的需求证据，维持现有执行轴；没有引入 CommandInbox、持久 steer 队列或新的状态机。最终验收与行动日志见文末。

以下为此前阶段的验收记录；本次边界收口与重新验收见文末行动日志。

- 阶段 1：已完成 Pie 侧实现与本地验收。
  - `packages/runtime/src/protocol.ts` 定义必填的 `SessionSnapshot.execution`；`runtime.ts` 用当前模型边界、活动工具集合、待确认请求和 checkpoint 投影，不读历史或账本，不保存第二份运行状态。
  - `modelStreaming` 独立于 `streamingMessage`：工具先完成并写入结果时，尚未结束的模型流仍为活动。`activeTools` 只含当前实例的工具调用 ID / 名称，允许多工具与模型流同时存在。
  - `waitingForInteraction` 表示本会话拥有待回答请求（包括转交父会话的子任务确认），不表示所有并发工作都已暂停。`cancellationRequested` 仅在 running Turn 期间表示停止请求，最终结果仍读取 Turn；结算后归零，不替代持久取消事实。
  - `recoveryBlockedReason` 只在 interrupted 时暴露 checkpoint 已知的阻断原因；没有此字段不等于允许 resume。中断原因继续由 `Turn.error` 表达，外部未知结果继续查询独立执行账本。
  - `session-events.ts` 合并摘要增量；快照、会话事件及全局事件使用同一投影。原始 Turn 状态不被重新分类；实例变化、版本缺口与旧事件仍沿用现有重建规则。
  - 新增 `packages/server/test/execution-state.test.ts` 并纳入 `test:server`，补充事件合并测试并更新 Runtime changelog。没有修改存储 schema、模型 / 工具执行协议或 Cloud。
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
- 完整验收：`npm run test:runtime` 62/62，`npm run test:server` 257/257；`npm run check` 通过（Biome 450 文件无额外修改，当时的类型检查、模型数据校验通过）；`git diff --check` 通过。
- 同步本 SPEC、`docs/agent-development.md`、`docs/runtime-embedding.md`、Server README 及 Runtime / Server changelog。保留全部未提交改动供审阅，未 commit；未修改 `/workspace/refs`，未调用付费模型，未 build 或部署，未开始阶段 4。Pie 侧无遗留待办；缺失分析工具的替代验证与模型数据环境恢复是本轮执行方式的偏差。

## 本轮版本与控制契约行动日志（ub-mode）

### First Make it Work

- 从 `5d3122f1a` 的干净 main 核对 SPEC、分层文档及完整相关源码、测试；依赖与模型数据已就绪，没有安装或改动依赖。先新增并确认工具开始、消息完成、取消持久化、完整异步快照和跨会话失败共 5 项预期失败；随后固定发布版本的 `execution / turn / leafId`。
- 先覆盖四入口状态组合，再合并准入逻辑。测试包含 48 组冷会话生命周期 / 恢复 / 根子会话组合，以及运行中、取消中、关闭与存储故障；区分新操作、重试、恢复深度校验和显式 `bestEffort`。
- 用真实 HTTP / SSE 覆盖断线期间结算且重连后没有新事件；用真实 SQLite 写入失败验证 503 原因码、当前回执重试和 `durable: false`，并检查持久历史与 Turn 不变。

### Then Make it Right

- 全局存储故障为已装载会话发布新版本；新增卸载后再激活的回归，确认不能复用相同版本表达不同 availability。只保留轻量版本切面和整数水位，不复制正文或工具账本。
- 补查异步窗口，另复现 3 项失败：历史读取期间跨会话故障丢结构化拒绝；故障通知发布另一命令随后回滚的 Turn；MCP 准备后越过存储屏障发起模型请求。统一存储拒绝，跨会话通知等命令回滚后发布，写入和模型启动在异步等待后重新检查屏障；不以未提交状态生成确定投影。
- 先用回归固定轻量基线行为，再去掉多余内容事件缓冲；元信息装载后同步订阅和交付已足以形成切面。完整快照显式按已固定叶子读原文，避免读操作中途混入后续消息。
- 环境没有 crapper / dryer / mutator。人工检查分支、重复和边界；用临时脚本撤掉投影缓存、固定叶子、故障通知、版本水位、submit gate、HTTP reason、重连基线、尽力停止的非持久标志、回滚屏障和模型启动屏障，10/10 均被断言检出；每项恢复前核对没有并发修改。未宣称取得缺失工具的 CRAP / 重复率评分。
- 关键实现为 `packages/runtime/src/{runtime,protocol}.ts`、`packages/local/src/runtime.ts`、`packages/server/src/server.ts`；回归位于 Server 的 `execution-state / global-stream / store / turn-recovery.test.ts`。同步嵌入文档、开发文档、Server README 和两个现有 changelog。

### Follow Practice

- 最终验收：`node --conditions=source --test packages/server/test/execution-state.test.ts packages/server/test/global-stream.test.ts` 25/25；SQLite 故障 / 恢复定向 2/2；`npm run test:runtime` 62/62；`npm run test:server` 274/274；`npm run check` 通过（Biome 450 文件，当时的类型检查、模型数据校验通过）；`git diff --check` 通过。共新增 17 项回归，全部纳入现有根脚本；48 组状态组合包含在同一回归内，不重复计为独立测试。
- 旧回归中“写入失败不发事件 / 内存 revision 不变 / 首次失败返回 500”的断言按本次契约更新；继续严格校验持久数据不变、原 Turn 保留和不额外启动模型。临时脚本已删除；保留全部未提交改动，未 commit / push，未改 refs 或阶段 4。
- Pie 本次范围无待办；没有调用付费模型、执行 build 或部署。缺失分析工具以人工审查和定向变异代替是执行方式偏差；没有工作摘要扩展的需求证据，维持原模型。宿主范围确认与阶段 4 验收仍由后续任务负责。
