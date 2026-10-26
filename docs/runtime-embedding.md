# Pie 运行时嵌入接入

本地 `astronverse-agent` 与云端 `agent-service` 是产品宿主，Pie 是共享运行时。本文件描述已落地的接入骨架，不表示云端数据库、tools-sdk 或多租户服务已经实现。演进范围见 [SPEC](specs/remote-loop-evolution.md)。

## 入口与现有行为

- `@pie/runtime`（根仓库也导出 `pie/runtime`）提供 `createRuntime`、`createAgentFactory` 和接入类型；这是源码入口，需要能解析 Pie workspace 依赖，并使用 `node --conditions=source`。不再从 `@pie/server/runtime` 导入。Cloud 只接入 `packages/pie/{runtime,agent,ai,telemetry,mcp}` 五个共享包，由外层 workspace 统一管理，不保留本地包或整仓外壳；发布产物与生产宿主装配仍待实施。
- `await createRuntime({ store, agents })` 不创建 HTTP 服务，也不默认打开 SQLite、扫描插件或注册本机工具；这些由注入的实现决定。
- `@pie/local` 的 `createLocalHost` 装配 SQLite、本地模型配置、原生 / 外部工具、Skill、MCP 与助手管理；`@pie/server` 的 `createCoreServer` 调用它并映射 HTTP / SSE。本地 CLI 和 Sidecar 的启动方式不变。

依赖方向为 `server → local → runtime → agent / ai`，`server` 可直接读取共享协议。Runtime 不导入 Local 或 Server，也不提供本地助手 / 插件的写入接口。云端 `agent-service` 直接使用 Runtime 并装配云端能力，不依赖 Local，不启动另一层 Pie HTTP 服务。本轮采用函数注入，不增加插件扫描或热更新框架。

## 双方开发范围

| Pie 维护方 | 服务端维护方 |
| --- | --- |
| 会话、消息树、Turn、压缩、Subagent 与运行事件 | `agent-service` 的认证、产品会话绑定、请求增强与事件协议转换 |
| `RuntimeStore` 契约与 SQLite 适配 | 服务数据库事务、作用域过滤与启动恢复接入 |
| `AgentFactoryOptions` 的能力注入与工具契约 | tools-sdk 适配、租户模型配置与凭据解析、文件 / Skill 资源部署 |
| 不同宿主共用的回归测试 | 真实数据库、SDK / Worker、权限与故障场景的云端验收 |

## 最小宿主装配

以下函数可作为 `agent-service` 装配位置的参考；依赖由服务端实现，不是已有云端 SDK 的声明：

```ts
import {
  createAgentFactory,
  createRuntime,
  type AgentFactoryOptions,
  type RuntimeStore,
} from "@pie/runtime";

export async function createCloudRuntime(
  store: RuntimeStore,
  capabilities: AgentFactoryOptions,
) {
  return createRuntime({
    store,
    agents: createAgentFactory(capabilities),
    sessionRetention: "release-after-turn",
  });
}
```

先注册宿主给出的助手定义，再创建会话：

```ts
await runtime.registerHostRuntimes([
  {
    assistantId: "assistant-a",
    assistantRevision: "1",
    runtime: {
      systemPrompt: "按用户要求完成任务。",
      toolIds: ["business_lookup"],
      skills: [],
      subagents: [],
    },
  },
]);

const session = await runtime.createSession({
  assistantId: "assistant-a",
  mode: "real",
});
const unsubscribe = await runtime.subscribe(session.id, (packet) => {
  console.log(packet.type, packet.turnId);
});
await runtime.submitTurn(session.id, { text: "查询订单状态" });
const settled = await runtime.waitForTurn(session.id);
unsubscribe();
await runtime.close();
```

上例的 `business_lookup` 必须存在于注入的工具目录中；真实模型必须由 `capabilities.models` 配置。生产宿主通常持续持有运行时并转发事件，而不是每次请求创建和关闭实例。

## 能力注入要求

`@pie/runtime` 的 `createAgentFactory(options)` 要求显式提供以下五项，不再隐式使用本地实现。`@pie/local` 的工厂保留本地默认装配；不要在云端导入它：

- `models`：`current` 返回 `models` 注册对象、默认选择 `selected` 与可选的 `headers(model)` 解析函数。凭据、端点与 header 解析由宿主限定作用域，不要求本地 `models.json` 结构。创建 Agent 时读取快照；同一模型 ID 的端点或凭据变化，应更新宿主的有效 `assistantRevision`，使下一个 Turn 重建 Agent，不改写在途配置。不得靠改写 `process.env` 切租户。
- `tools`：提供 `catalog` 和 `create(context, enabledToolIds)`。返回现有 `AgentTool` 实现，可用 `exposure: "deferred"` 参与工具发现；`execute(toolCallId, params, signal, onUpdate)` 内调用 tools-sdk，通过 `context.ask` 请求确认。Runtime 不注册本机工具或扫描 `PI_TOOLS_DIR`；参数校验、结果与进度继续走原 Loop。
- `skills`：提供技能工具装配与工具后处理。尚未实现云端资源读取时，应明确拒绝非空技能配置，而不是把云端路径当成本机目录；读取本地目录的实现在 Local。
- `mcp`：提供当前执行范围的配置、状态、连接取得与关闭能力。未实现云端 MCP 时，应明确拒绝非空配置；可能启动本机进程的连接实现在 Local。
- `recordModelRequest`：提供宿主自己的请求记录策略，可以显式不记录。完整请求写文件的实现在 Local；云端宿主自行处理敏感数据、保存权限和保留时间。

`env` 为可选的工厂环境快照，Runtime 不默认读取 `process.env`。`compactionSettings(model)` 可选；省略时仅使用纯计算的预算默认值，不读文件。本地工厂注入文件配置读取实现。

宿主可以在 `AgentRuntimeConfig.compaction` 提供 `{ thresholdTokens }`，空对象表示使用模型预算默认值。参数随 host runtime revision 在下一 Turn 生效，并传入对应的 Subagent；该模式直接使用宿主参数，不读取本地 `settings.json`。未提供该字段的独立运行模式仍使用工厂注入的 `compactionSettings(model)`。阈值必须为正整数，实际压缩预算仍受模型上下文窗口与保留量约束。

目前 Skill 绑定仍采用目录字段；对象存储引用、Worker 路径映射和跨环境资源协议尚未实现。这是后续接入工作，不要用虚构路径绕过它。

## 存储契约

`RuntimeStore` 只负责运行会话，不要求服务端实现本地助手管理或插件市场。

- `readSession(id)` 只读取当前授权范围内的指定会话元信息，缺失返回 `undefined`；`listSessions({ limit, cursor?, assistantId?, kind?, parentSessionId? })` 返回 `{ sessions, nextCursor }`，每页 1–200 条，按 `updatedAt DESC, id DESC` 排序，游标为最后一条的 `{ updatedAt, id }`。两个操作均不读取消息正文；列表不激活 Session。原 `loadSessions` 已移除，Store 适配须一并迁移。
- `createRuntime` 不查询会话；首次访问才读取目标元信息。适配实现须在目标装载前完成归属核对与遗留执行修复；指定会话仍为 `running` 时该操作返回 409，不阻塞其他会话，也不自动重放。本地 SQLite 通过持久恢复标记和索引修复遗留 Turn / Activity；首次升级会迁移旧数据并创建索引，此后启动不保留全量元信息数组。
- Runtime 的 `listSessions` 默认每页 50 条，接受 `limit/cursor`，返回 `nextCursor`；过滤使用 `assistantId/includeSubagents`。按 ID 装载在实例内合并，列表与执行缓存独立。更新会话会改变分页位置，分页不是跨写入的固定快照；刷新列表时从第一页重新读取。`listSessionMetadata()` 是显式全范围管理扫描，供本地配置引用检查使用，不用于云端常规查询或启动。
- `saveSession` 的 `tree.nodes` 是待提交的新节点，`tree.leafId` 是提交后的分支叶子；不要把 `messages` 再保存为第二份完整正文。消息节点、叶子、revision、压缩状态与必要运行状态应原子提交；导入替换同样必须原子完成。必须保留可选 `turnCheckpoint`，并在终态提交时允许清除，不能在元信息映射中丢弃该字段。
- 保存失败必须 reject；运行时不会启动尚未成功提交的用户回合，并停止接受后续写操作。云端事务和并发冲突检测由适配实现负责；当前骨架不提供多实例抢占或恰好一次执行保证。
- 父指针决定消息路径，seq 用于排序与分页；保留稳定节点 ID、历史分支、导入原文、图片和工具结果。`readHistory` 从选定叶子向上读取 `limit + 1` 个候选节点后停止，`readWorkingPath` 只遍历到 `firstKeptEntryId` 与可选 `turnStartEntryId`；读取工作窗口不能退回全量加载。显式的 `readPath`、`readTree`、导出仍是完整读取。详细数据语义沿用 [历史存储 SPEC](specs/history-storage.md)。
- `readTurnPath(id, inputEntryId, leafId?)` 从指定叶子沿父指针读取到 Turn 输入即停止，不先遍历全部祖先再过滤；首节点作为局部根节点返回，保留原 ID 和 seq，不改写持久父指针。输入缺失或不在选定分支时返回 `{ leafId, nodes: [] }`，保留选定叶子；叶子缺失及数据库读取错误仍 reject。共享判定将无效路径判为不可恢复；SQLite 失败修复可回读 `readPath`，显式恢复则拒绝执行，不自动切换分支。该接口不限制当前 Turn 本身的长度或字节数。
- `readHistory(id, { limit, beforeSeq?, leafId? })` 必须在存储查询中按父指针和游标限制遍历，返回最多 `limit` 条正文及 `nextBeforeSeq`；达到页大小后不继续读取更老节点。`beforeSeq <= 1` 直接返回空页。分页只限制普通读取，不改变显式完整导出和树管理操作。

助手定义和 runtime 注册表由产品宿主提供。`hostRuntimes` 可传入启动快照，`saveHostRuntimes` 可在注册更新时先保存；省略后者时注册只驻留内存，由宿主在重启后重新注册。注册是当前实例范围内的完整替换，不能直接暴露为跨租户的共享注册接口。

## 事件、隔离与生命周期

- `submitTurn` 返回已接纳的 turn 标识；不等于模型完成。用 `turn.settled` 或 `waitForTurn` 判断终态；运行时仍使用同一份 Agent Loop。
- `await subscribe(...)` 装载目标元信息并返回取消订阅函数；`subscribeAll(...)` 仍同步返回。两者不自动发送初始快照，也不持久重放事件。宿主可用 `getSession` 读取快照；订阅回调不应阻塞或抛错，异步投递与背压由宿主承担。
- `cancelTurn` 需要当前 `turnId`，确认回复用 `replyInteraction`，运行中追加输入用 `steer`。取消只是向工具传递信号；SDK / Worker 必须核对实际停止状态。
- 当前单实例按顺序接纳控制操作，避免异步存储下重复提交；不同会话的模型执行可并行。此处不是分布式锁，也不是跨节点调度器。
- `sessionRetention` 默认 `"retain"`，本地继续复用内存中的 Agent 和工作历史；宿主可显式传入 `"release-after-turn"`，在回合结果提交、事件收尾完成后解除 Agent 和消息引用，下一轮通过 `store.readWorkingPath` 加载 checkpoint 工作窗口并重建。该策略不选择数据库，Redis / SQL 仍由宿主实现 `RuntimeStore`。
- 卸载不调用 `deleteSession`、不关闭共享 MCP / 存储。没有执行、后台工作、确认、读操作或订阅引用时，从实例缓存移除整个 Session；下一次访问通过 `readSession` 重建元信息。订阅期间保留轻量 Session，但仍回收已提交工作正文。创建、导入、分叉、分支选择和闲置元信息写入遵循同一策略。完整历史浏览和导出仍临时读取持久数据；本地 HTTP 默认完整会话列表由 Local 分页汇总，不因此预载执行对象。
- 运行中、排队输入、待确认或相关后台任务会阻止卸载；Subagent 先提取结果再释放，后台完成通知进入同一接纳通道。成功、失败和取消都以最终保存成功为释放前提；写入失败保留内存并停止接受后续写入。调用方自行持有的快照不受此策略管理，也不保证 RSS 立即下降。
- 一个实例对应一个已经限定权限的运行范围；存储、模型配置和工具实现都必须来自该范围。不得把不同租户的全局配置与数据放进同一实例，再依靠请求正文里的租户 ID 做隔离。
- `close` 幂等，停止本实例的在途执行并关闭注入的 MCP 与存储；外部持久任务只解除等待，不发取消请求。不要让多个实例共享同一个有独立关闭语义的 Agent 工厂；共享数据库连接池的适配器只释放自己拥有的资源。

## 中断 Turn 的显式恢复

`recoverInterruptedTurn(metadata, tree)` 是不执行工具、不写存储的共享判定：已提交输入或完整工具结果可标为 `interrupted`；有合法外部任务关联的未完成调用也可标为 `interrupted`，但必须先查询结果才能继续；最终 Assistant 已提交则补结算。缺少 checkpoint、未关联的未知工具或本阶段不支持的队列仍失败。它只验证历史与 checkpoint，不代替工具账本、远端任务状态或执行归属检查。

宿主先取得有效 owner 并阻断旧执行者、核对授权和工具事实，再通过 `readTurnPath` 读取当前 Turn 后缀、调用判定并原子保存返回 Turn；终态同时清除 checkpoint。之后才能让 Runtime 装载该会话；仍然返回 `running` 会被拒绝装载。空路径、断链或循环返回失败判定，不抛出路径异常；存储读取错误仍由宿主处理。后缀只用于恢复判定，继续执行仍通过 `readWorkingPath` 恢复模型工作上下文，不用后缀替代先前历史。

对 `interrupted` 调用 `runtime.resumeTurn(sessionId, { turnId })`：保持原用户消息、Turn/request ID、已应用 runtime/模型和实际 system prompt，准入保存成功后才调用模型；已完成工具不重放。对该 Turn 调用 `cancelTurn` 可以可靠取消而不构造 Agent。恢复或取消前不能直接提交下一 Turn 或替换历史。

本地 SQLite 默认保持中断即失败的行为，以免尚未支持恢复入口的 Astron 宿主被阻塞。显式设置 `PI_TURN_RECOVERY=manual` 后启用安全分类和 HTTP / Web 恢复入口；启动不会静默调用模型。Cloud 直接使用共享契约，不读取这个本地环境变量；现有 Cloud 恢复器仍需增量适配，不因新增接口就自动获得续跑能力。完整范围见 [Turn 恢复 SPEC](specs/turn-recovery.md)。

## 外部异步任务

### 工具执行账本

所有工具调用统一归属 `Turn -> ToolExecution`，Job 只是外部执行器适配名称。普通工具默认 `inline`，内置 Task 使用 `delegated`，已通过 `runJob` 关联外部执行的调用使用 `durable`。外部工具可以声明 `toolExecutionMode`；这个字段不同于控制并行/串行的 `executionMode`，也不会让普通 Promise 自动获得跨实例恢复能力。

共享 Runtime 通过 Agent 的可等待事件记录调用开始，在最终后处理后的 `toolResult` 提交时记录 `completed` / `failed`；外部提交额外记录 `submission_intent` / `submitted`，结果不确定时保留 `recovery_required`。它是账本阶段，不是新的公开 Turn 状态。

Store 适配须实现新的提交与读取契约：

- `saveSession(session, replaceHistory?, toolExecutions?)`：第三个参数是本次增量事实，必须与历史节点及 Session/Turn 元信息同一事务提交；不能忽略或在提交后另写。以 `(sessionId, record.id)` 去重，身份冲突拒绝，不覆盖已经提交的事实。
- `readToolExecutions(sessionId, { turnId, limit, afterSeq? })`：按账本 seq 升序读取指定 Turn，每页 1–200 条，返回 `{ entries, nextAfterSeq }`。必须将作用域、游标和 limit 下推到存储，账本 seq 不等于历史 seq 或 SSE revision。
- 账本独立存储，终态清理 checkpoint、开启下一轮或替换历史不删除它；会话删除时清理。常规会话元信息、HTTP/SSE 快照均不包含完整账本。Runtime 和本地封装提供同名分页读取方法，不新增 HTTP 任务平台。

`resumeTurn` 在查询外部任务前检查账本身份、历史调用/结果和 checkpoint 关联。提交响应丢失不等于没提交，重启后不会因缺少 `submitted` 就重提。账本不提供工具内部断点、自动重放或恰好一次副作用；Cloud 仍负责授权、租约和旧执行者隔离。SQLite 适配已提供独立表和原子提交，Cloud 的 MySQL/Redis 适配须增量接入，不要直接覆盖同事代码。

`RuntimeOptions.jobs` 可注入 `DurableJobExecutor`；未注入时不提供 `context.runJob`，原本地 `BackgroundJobs`、Shell 和 Subagent 不变。外部工具在权限确认后调用 `context.runJob(toolCallId, signal)`，Runtime 从已提交的工具调用取得工具名和参数，不保存或转移执行函数。即使工具省略可选 signal，Runtime 也会关联当前 Turn 的停止信号；外部结果只承载 `content/details/usage`，不传递工具动态注册或提前终止指令。

执行器需要实现：

- `submit({ id, sessionId, turnId, toolCallId, toolName, arguments }, signal?)`：以稳定 `id` 幂等提交，返回前可靠保存任务关联。若远端分配自己的 taskId，由适配器持久映射，不能只放 Map。PIE 在调用前已经将关联保存到 `turnCheckpoint.jobs`。
- `get(reference, signal?)`：从持久事实返回同一身份的 `running / completed / failed / cancelled / unknown`；完成结果包括原始文本/图片和 details，成功状态不能缺少结果。缺失、未知或身份不匹配拒绝继续，PIE 不重新提交。
- `cancel(reference)`：可靠提交取消请求，不等于远端已停止或副作用已撤销。`signal` 只取消当前提交/查询的网络等待，不能把进程关闭解释为取消外部任务。执行器的资源和关闭由宿主管理，Runtime 不关闭共享执行器。

普通执行会查询直到任务终态；`pollIntervalMs` 默认 1000 毫秒，可设 1–60000。提交响应丢失、查询失败或服务关闭时，Runtime 保留关联和已提交历史，标为 `interrupted`，不保存由本地中止产生的虚假工具错误。

新实例先由宿主取得有效归属，再调用 `resumeTurn`。PIE 只查询未提交结果的原任务；仍运行返回 409，缺失/未知/身份不匹配也拒绝，查询故障向调用方传播。全部缺失结果明确后，结果与 Turn 准入原子提交，再用原配置调用模型。已落盘结果不重复消费，无需依赖旧实例回调或收到通知；宿主可通过通知唤醒后重复查询。

显式取消先保存意图再请求执行器；历史补入带任务身份的“取消已请求、最终结果需核对”错误结果，不能据此宣称任务已被取消。未关联的本地异步函数、后台 Subagent、持久确认和工具内部 checkpoint 不在本阶段范围，详见 [外部任务 SPEC](specs/durable-jobs.md)。

## 骨架验收

在仓库根目录执行：

```sh
npm run test:runtime
node --expose-gc --conditions=source --test packages/runtime/test/runtime.test.ts
```

使用延迟存储替身、注入工具与 faux 模型，覆盖无 HTTP / SQLite 的工具循环、进度、历史恢复、并发提交拒绝、写入失败、用户确认和取消，以及两种保留策略、checkpoint 重建、Subagent / 后台通知和历史分支。第二条命令额外用 WeakRef 与显式 GC 验证 Agent 和工作正文可回收；不以 RSS 变化代替引用验证。不使用真实云端服务或付费模型；这不替代第二阶段的云端闭环验收。
