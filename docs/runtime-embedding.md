# Pie 运行时嵌入接入

本地 `astronverse-agent` 与云端 `agent-service` 是产品宿主，Pie 是共享运行时。本文件描述已落地的接入骨架，不表示云端数据库、tools-sdk 或多租户服务已经实现。演进范围见 [SPEC](specs/remote-loop-evolution.md)。

## 入口与现有行为

- `@pie/runtime`（根仓库也导出 `pie/runtime`）提供 `createRuntime`、`createAgentFactory` 和接入类型；这是源码入口，需要能解析 Pie workspace 依赖，并使用 `node --conditions=source`。不再从 `@pie/server/runtime` 导入。Cloud 只接入 `packages/pie/{runtime,agent,ai,telemetry,mcp}` 五个共享包，由外层 workspace 统一管理，不保留本地包或整仓外壳；发布产物与生产宿主装配仍待实施。
- `await createRuntime({ store, agents })` 不创建 HTTP 服务，也不默认打开 SQLite、扫描插件或注册本机工具；这些由注入的实现决定。
- `@pie/local` 的 `createLocalHost` 装配 SQLite、本地模型配置、原生 / 外部工具、Skill、MCP 与助手管理；`@pie/server` 的 `createCoreServer` 调用它并映射 HTTP / SSE。本地 CLI 和 Sidecar 的启动方式不变。

依赖方向为 `server → local → runtime → agent / ai`，`server` 可直接读取共享协议。Runtime 不导入 Local 或 Server，也不提供本地助手 / 插件的写入接口。云端 `agent-service` 直接使用 Runtime 并装配云端能力，不依赖 Local，不启动另一层 Pie HTTP 服务。能力采用函数注入；Skill 绑定复用模型调用间隙刷新，不扫描插件或监听文件。

## 双方开发范围

| Pie 维护方 | 服务端维护方 |
| --- | --- |
| 会话、消息树、Turn、压缩、助手通信与运行事件 | `agent-service` 的认证、产品会话绑定、请求增强与事件协议转换 |
| `RuntimeStore` 契约与 SQLite 适配 | 服务数据库事务、作用域过滤与启动恢复接入 |
| `AgentFactoryOptions` 的能力注入与工具契约 | tools-sdk 适配、租户模型配置与凭据解析、文件 / Skill 资源部署 |
| 不同宿主共用的回归测试 | 真实数据库、SDK / Worker、权限与故障场景的云端验收 |

## 幂等创建与核对

`createSession` 可选传入 `creationKey`，作用域为当前 Runtime 的授权域和存储。同键、相同创建参数返回原会话的当前快照，不创建 Agent 或重新执行；参数不同返回 409。键先去除首尾空白，长度为 1–256，不能含空字符；比较参数包含显式 assistantId、规范化标题/工作目录、mode 和显式 model，不随默认助手或模型配置变化重新计算归属。不传键保持每次新建。

宿主持久存储可选实现 `readSessionCreation(key)`。实现该方法即承诺 `saveSession(session, replaceHistory?, toolExecutions?, { creation? })` 将创建记录和首次会话保存放在同一事务，唯一键冲突回滚整个写入，不能忽略第四参数。SQLite 已接入；旧适配器仍支持普通创建，带键请求和查询返回 405。此契约仍要求每个授权域由单个 Runtime 执行，不提供跨实例创建仲裁。

创建响应丢失时调用 `getSessionCreation(key)`，返回 `{ creationKey, sessionId, createdAt, sessionExists }`；不存在返回 404，不返回内部参数指纹。删除会话保留创建记录，迟到重试返回 409，查询显示 `sessionExists: false`，不能用原键悄悄新建。键应由宿主为单次创建意图分配，不能写入密钥。当前没有创建记录过期清理策略。

## 可选 Worker 内部调度

所有根 Session 使用所属 Assistant 的 Worker 身份；不存在普通/Worker 会话模式开关。`WorkerScheduler` 复用 `createRuntime` 的 Session/Turn API，另注入 `WorkerCoordinationStore`；协调模块不拥有或关闭共享 Runtime。Local HTTP 宿主已自动装配，嵌入宿主通过以下方式提供通信服务；未提供时不能使用助手通信，也不会获得 `task` 回退：

```ts
import { createRuntime, WorkerScheduler } from "@pie/runtime";

let workers: WorkerScheduler;
const runtime = await createRuntime({
  store: runtimeStore,
  agents,
  workers: {
    send: (...args) => workers.send(...args),
    wait: (...args) => workers.wait(...args),
    cancel: (...args) => workers.cancel(...args),
    inputs: (...args) => workers.inputs(...args),
  },
});
workers = new WorkerScheduler({
  runtime,
  store: {
    ...coordinationStore,
    readSession: (id) => runtimeStore.readSession(id),
  },
});
await runtime.registerHostRuntimes(definitions);
await workers.syncHostRuntimes(definitions);
const received = await workers.enqueueWorkerMessage({
  messageId: "stable-host-event-id",
  workerId: "contract-assistant",
  sourceWorkerId: "contract-assistant",
  content: "审查合同甲",
  newSession: true,
  workspacePath: "/workspace/contract-a",
  model: { provider: "configured-provider", id: "configured-model" },
  mode: "real",
  productBinding: { astronSessionId: "product-session-a" },
});
// 入箱收据不表示执行完成。用 deliveryId 查询，不生成新 ID 重投。
const delivery = await workers.getWorkerDelivery(received.delivery.deliveryId);
```

同一 `assistantId` 对应一个逻辑 Worker，注册刷新只更新配置关联，已有 Session 的 Turn 继续遵循 Runtime 配置边界。Local 助手的创建、更新、删除会同步 Worker 的创建、配置刷新和删除；Local Runtime 启动时也会为已保存助手补齐 Worker。这个 Worker 记录是长期身份，不代表进程或 Session；具体工作仍在首次收件时懒创建或复用 Worker Session。新工作使用目标 Worker 的默认选择或消息中宿主明确提供的目录/模型，`productBinding` 字符串或对象的 `astronSessionId` 写入 Session 创建身份并随导出保留；不继承来源 Session 的历史、权限或目录。补充传 `workId`（唯一关联）、`targetSessionId` 或合法 `replyTo`；关联不唯一保持 pending，不猜测最近会话。HTTP 入口的来源身份仍仅由可信宿主填写，不能把此入口直接作为模型工具。

嵌入宿主在 `createRuntime` 注入 `workers: WorkerCommunication`；Local 已自动装配。上述闭包将调用转给稍后创建的 `WorkerScheduler`，存储需同时实现 `WorkerCommunicationStore`、`SessionWriteOptions.workerInputs` 和 `SessionWriteOptions.workerWait` 的原子提交。每个 Assistant 是同 ID 的 Worker，根 Session 使用该身份，助手协作统一为 `communicate`。`task` 及父子派发已移除，旧工具记录、子会话和账本仍可读取。

`createSession({ assistantId, ... })` 创建空根 Session，不提交 Turn 或启动模型，也不为普通聊天预建工作项。通信时按需为会话建立 WorkItem 与 Assignment；调度器显式创建工作会话时仍可提前建立这些关联。Session 创建身份、WorkItem 和 Assignment 分步保存，重试复用稳定创建键与关联身份，不承诺跨步骤事务。省略 `creationKey` 的创建重试仍可能产生另一个 Session。

懒关联要求调度存储提供与 Runtime 相同授权域的 `readSession`；存储分离时须如上透传，缺少该方法时返回 405。`createAssignment(assignment, { requireSession: true })` 必须在关联写入的同一事务中确认 Session 仍存在、属于该 Worker 且为根会话，不能忽略第二参数或只在写入前异步检查。删除或停止的关联不能被重试复活。懒关联不固定会话模型，后续来信仍使用 Session 当前的模型选择。

`communicate({ to, content, kind?, session_id?, reply_to?, new_session?, wait? })` 的 to 是获准助手的 assistantId。宿主可独立注册 `runtime.workerTargets: [{ assistantId, name, description }]`，不必提供 legacy `subagents` 绑定；仅省略 `workerTargets` 时回退到 `subagents`，显式空数组禁止主动目标。注册时拒绝重复或不在同一注册表的目标。发送时取本 Turn 已装配目录与最新授权的交集：撤销后的目标不能继续发送，新增目标需到下一 Turn 配置应用后才进入目录。来源 Worker/Session/Turn 和稳定工具调用键由 Runtime 注入。保存后立即发布发送回执，request/question 默认继续等待；`wait: false` 仅发送，reply/result/progress 默认仅发送。有效 reply_to 按双方 Worker、Session 与原消息因果链返回准确的来源 Session，不要求反向主动授权。跨工作会话的合法通信不合并工作归属。

`communicate` 的 `wait: { mode?, timeout_ms? }` 控制等待；mode 为 `sync` 或 `async`，默认取宿主 `runtime.workerWaitMode`，再缺省为 `async`。仅等待本 Session 发起消息的有效回应。已有消息可用 `communicate({ message_id, wait? })` 续等，不重复发送。内部 `WorkerCommunication.wait(context, messageId, signal?, { mode?, timeoutMs? })` 使用毫秒驼峰字段。旧 send_message/wait_message 历史及省略 mode 的异步等待记录仍可读取。

`sync` 每段保留当前 Turn 和工具 Promise，等待期间没有模型请求；每段最长 30 秒，或在有待接纳新输入时提前返回。尚无匹配回应时返回 `wait.status: "waiting"` 与 `reason: "interval" | "message"`，不设置 Turn.yield；模型处理进展后可用原 `message_id` 续等。有效 `question/reply/result` 在返回前再次检查并优先领取；progress 不表示 ready 或工作完成，新输入仍经 Runtime 既有模型调用间隙机制与历史同事务消费，不另建消息通路。工具卡心跳只用于展示，不注入模型上下文。

仅用户明确要求时传 `timeout_ms`（1–300000），它限定本次等待调用，到期返回 `wait.status: "timed_out"`；大于 30 秒时先返回 interval，后续等待以新调用重新计时，不是工作整体期限。分段返回与超时均不取消原请求，也不隐式变成 async。已受理目标 Turn 的明确失败保存在 consumed delivery 的 error，同步先领取已有有效回应，否则结束等待并报告失败。目标为当前 Session 的请求拒绝同步等待；跨 Session 互等不建立全局依赖图。取消和迟到消息沿既有边界处理；调用方可显式登记 async 让出。协作主助手约 60 秒保持沟通及 Worker 发送实质阶段 progress 属于模型软规范，运行时不定时生成正文。

同步回应先持久独占，常规 `inputs/admit` 不再投递该回应。返回的 `WorkerWaitResult.receipts` 只描述已独占、尚待提交的 delivery；Runtime 用可信调用上下文保存 `SessionWriteOptions.workerWait: { waitId, toolCallId, responses: [{ deliveryId, messageId }] }`。存储须核对等待、当前 Session/Turn/工具与独占归属，在保存最终 toolResult 和执行账本的同一事务中标记回应 consumed、等待 ready。不得先消费后异步保存历史；保存失败不能将回信另起 Turn 重投。已在普通历史消费的回应可直接返回 ready，无新 receipts。

`async` 保持立即返回等待事实的行为。没有有效回应时保存正常工具结果，再让模型生成面向用户的正常收尾；直到无工具调用的 assistant 消息完成，Agent 的 `shouldStopAfterTurn` 才保存让出并结束执行。Turn 为 completed 且含 `yield: { reason: "waiting_for_message", waitId, messageId }`，执行投影另含 `waitingForMessage`。收尾期间到达的回复和追问持久排队，在当前 Turn 完整清理后于原 Session 新建 Turn，不进入收尾模型上下文；ready 回执继续正常处理，不请求让出。取消或模型失败沿原终态处理。这表示本轮执行让出，不表示工作完成；异步等待不占执行中的工具 Promise，两种模式都不建立父子取消关系。

同一回应只由一个等待领取；再次等待原请求不会重复返回已经处理的追问。明确的接纳前失败会生成稳定 `result` 回原 Session；已受理或派发结果未知时保留原收据，不伪造失败或重放。

取消准确的已让出 Turn 仍是有效操作：持久撤销其等待和自动回复唤醒，状态改为 cancelled。迟到消息保留可查收据，不恢复被取消请求；同助手其他 Session 和对端 Worker 不受影响。服务重启只保留协调事实，不自动恢复待执行消息。

Runtime 注册表提交与 Worker 配置同步是两个保存边界；后者失败时不能推断前者回滚，可按同一配置重试或重启核对。移除 runtime 配置保留 Worker 历史，但拒绝它的新执行。

消息先入 SQLite，再后台建立工作/Session 关联。`pending/resolved/dispatched/accepted/consumed/failed` 分别表示待关联、已关联、已尝试派发、已受理、已进入持久历史及接纳前失败；真实 Runtime 将历史与 consumed 在同一事务提交，可能直接从 resolved/dispatched 进入 consumed。`consumed` 不表示 Turn 结算或业务成功，实际结果仍读对应 `acceptedTurnId` 的 Turn。每个 Session 按入箱顺序串行，不持 Worker 全局锁等待执行。运行中的已关联消息在下一模型调用间隙批量保存到历史并消费，最终交接后到达的消息仍由队列启动下一 Turn；不使用非持久 steer 冒充可靠输入。

`waitWorkerDelivery` 仅等待当前实例已经安排的投递；pending、关闭或重启后未知记录可能直接返回，不能把它当作持久等待或重启自动恢复。已受理/已派发/已消费/失败的重复消息不重新执行，同 ID 不同正文或选择返回 409。关闭时先 `workers.stop()`，再关闭 Runtime；Runtime 的 store 关闭前 `await workers.drain()`，让在途投递先写完收据。未知派发结果保留可查询事实，不自动重放工具副作用。

调度使用 `waitForTurn(sessionId, { onWait, onSettled })` 的可选同步回调：分别取得等待起点及同一 Turn 结算时的独立副本，完整快照仍可能在异步读取后观察到后续 Turn。嵌入宿主若自行适配这三个 Runtime 方法，必须保留该观察语义。取消截止据准确结算切面固定；取消前排队的补充不能复活，取消后的显式新请求可执行。受理 Turn 在等待登记前已被其他 Turn 替换时，保留 accepted 并明确要求对账。

`WorkerCommunicationStore.recordWorkerTurnCutoff(sessionId, turnId, workerId, sequence)` 按 Session/Turn 固定截止点，返回该 Session 的累计截止序号；`readWorkerTurnCutoff(sessionId)` 读取它。通信存储须在保存 cancelled/failed/interrupted 终态（含启动恢复）时同事务冻结对应 Worker 的当前收件序号，并在 `workerInputs` 原子接纳时拒绝截止前输入；重复保存或取消重试不能扩大截止点。只有持久 interrupted → 同 Turn running 的显式续跑才重新武装下一终态的冻结，保留原截止点；续跑后再次取消覆盖其间排队输入。SQLite 已实现；嵌入宿主提供通信能力时须保持这一原子边界。

模型外发消息须在保存前核对来源 Worker、Session 关联及其工作项尚未停止，合法因果回信同样校验；已保存同键重试仍返回原收据。暂停仅阻止新执行接纳，不阻止已运行 Session 回信。系统生成的明确失败通知不作为模型外发处理。

SQLite 接纳新 Worker 输入时同事务复核目标 Worker active、关联未停止及工作项未停止；已 consumed 的同 Turn 重写保持幂等。暂停竞争导致的明确拒绝回到 resolved 后退出当前调度，不循环重试或伪装失败。Local 删除会话先停止关联、取消等待及终结未受理投递，再清理 Runtime 缓存并向仍存在的来源回报失败；通知保存失败明确说明会话已删除，重复删除仅凭持久停止关联核对并重报，不复建 Session。自动重报与重启续跑仍未实现。

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
// Turn 已结算；直接拥有的本实例作业仍可能运行。
const background = await runtime.listBackgroundJobs(session.id);
unsubscribe();
await runtime.close();
```

上例的 `business_lookup` 必须存在于注入的工具目录中；真实模型必须由 `capabilities.models` 配置。生产宿主通常持续持有运行时并转发事件，而不是每次请求创建和关闭实例。

## 能力注入要求

`@pie/runtime` 的 `createAgentFactory(options)` 要求显式提供以下五项，不再隐式使用本地实现。`@pie/local` 的工厂保留本地默认装配；不要在云端导入它：

- `models`：`current` 返回 `models` 注册对象、默认选择 `selected` 与可选的 `headers(model)` 解析函数。凭据、端点与 header 解析由宿主限定作用域，不要求本地 `models.json` 结构。创建 Agent 时读取快照；同一模型 ID 的端点或凭据变化，应更新宿主的有效 `assistantRevision`，使下一个 Turn 重建 Agent，不改写在途配置。不得靠改写 `process.env` 切租户。
- `tools`：提供 `catalog` 和 `create(context, enabledToolIds)`。返回现有 `AgentTool` 实现，可用 `exposure: "deferred"` 参与工具发现；`execute(toolCallId, params, signal, onUpdate)` 内调用 tools-sdk，通过 `context.ask` 请求确认。Runtime 不注册本机工具或扫描 `PI_TOOLS_DIR`；参数校验、结果与进度继续走原 Loop。
- `skills`：提供技能加载工具装配与工具后处理。共享 Runtime 自行提供 `skill_search`，只查询当前 `runtime.skills` 的绑定元数据，不读取技能文件或调用宿主加载器；具体搜索契约见 [技能发现与加载](agent-development.md#plugin-与-skill)。尚未实现云端资源读取时，应明确拒绝非空技能配置，而不是把云端路径当成本机目录；读取本地目录的实现在 Local。
- `mcp`：提供当前执行范围的配置、状态、连接取得与关闭能力。未实现云端 MCP 时，应明确拒绝非空配置；可能启动本机进程的连接实现在 Local。
- `recordModelRequest`：提供宿主自己的请求记录策略，可以显式不记录。完整请求写文件的实现在 Local；云端宿主自行处理敏感数据、保存权限和保留时间。

Local 的默认记录器设有跨会话容量、条数、期限及单条上限，支持关闭新增记录，并随会话删除清理文件。超限或文件故障不改变模型 payload 与执行结果；它不是可靠全量审计。嵌入宿主注入自己的记录器时仍自行拥有生命周期，不会隐式创建这些本地文件，配置见 [本地记录策略](../packages/server/README.md#模型请求记录)。

`env` 为可选的工厂环境快照，Runtime 不默认读取 `process.env`。`compactionSettings(model)` 可选；省略时仅使用纯计算的预算默认值，不读文件。本地工厂注入文件配置读取实现。

宿主可以在 `AgentRuntimeConfig.compaction` 提供 `{ thresholdTokens }`，空对象表示使用模型预算默认值。参数随 host runtime revision 在下一 Turn 生效，协作目标使用自己的配置；该模式直接使用宿主参数，不读取本地 `settings.json`。未提供该字段的独立运行模式仍使用工厂注入的 `compactionSettings(model)`。阈值必须为正整数，实际压缩预算仍受模型上下文窗口与保留量约束。

`AgentRuntimeConfig.maxHistoryImageBytes` 可选，必须为正安全整数，默认 16 MiB。它控制请求中图片 base64 字符串的编码总量目标，不是完整 HTTP 请求的大小上限；最新真实用户的图片全部保留，可能超过目标。宿主更新配置后随 host runtime revision 在下一 Turn 重建时生效；协作目标使用自身配置。独立本地模式使用同一默认值，本轮没有新增 `settings.json` 或环境变量开关。投影顺序、摘要图片与原始历史保留规则见 [图片上下文](compaction-integration.md#图片上下文)。

宿主可通过 `AgentRuntimeConfig.allowedDirectories` 提供最多 128 个绝对目录，作为会话工作区之外默认可访问的路径范围。注册时校验并规范化，Agent 工厂通过工具上下文传递；本地文件读写、命令工作目录和参数路径共用此范围，不跳过命令、凭据或业务确认策略。协作目标使用自身目录授权，不继承来源助手范围；目录只由宿主配置下发，模型工具参数不能新增授权。云端工具由对应宿主实现相同的授权语义，不自动获得本机文件访问能力。

目前 Skill 绑定仍采用目录字段；对象存储引用、Worker 路径映射和跨环境资源协议尚未实现。这是后续接入工作，不要用虚构路径绕过它。

## 交互授权记忆

原生权限请求可携带 `InteractionRequest.remember: { permission: "bash" | "external_directory", patterns: string[] }`。范围由可信工具实现生成，Runtime 校验它与 `metadata.permission` 一致；宿主只对带有效范围的请求展示“始终允许”。`replyInteraction` 的 `InteractionReply` 为 `{ approved: boolean, remember?: boolean }`：允许一次只传 `approved: true`，始终允许另传 `remember: true`，拒绝传 `approved: false`。拒绝时要求记忆、或为无范围请求要求记忆，均返回 400；凭据、邮件等业务确认不提供此范围。

`patterns` 是精确匹配的内部标识，不是通配符。Local 按命令入口和工作目录生成类别，包括 Git 子命令、包管理器的 `run` 脚本，以及 Python / Node 脚本；同一入口可复用不同参数，换脚本、子命令或工作目录重新确认。复杂 Shell 语法和未识别的命令使用完整命令匹配。工作区外访问保留准确路径与读写操作；命令参数路径另绑定命令类别，不把单个路径授权扩大到父目录。

授权属于实际执行工具的 Session，跨 Turn、Agent 回收和服务重启保留；即使子会话的交互经父会话接口回答，也只记在该子会话。新会话、Fork 和父子会话之间均不继承授权。已有宿主 `permissions` 决策仍独立生效。

## 存储契约

`RuntimeStore` 只负责运行会话，不要求服务端实现本地助手管理或插件市场。

- `readSession(id)` 只读取当前授权范围内的指定会话元信息，缺失返回 `undefined`；`listSessions({ limit, cursor?, assistantId?, kind?, parentSessionId? })` 返回 `{ sessions, nextCursor }`，每页 1–200 条，按 `updatedAt DESC, id DESC` 排序，游标为最后一条的 `{ updatedAt, id }`。两个操作均不读取消息正文；列表不激活 Session。原 `loadSessions` 已移除，Store 适配须一并迁移。
- `createRuntime` 不查询会话；首次访问才读取目标元信息。适配实现须在目标装载前完成归属核对与遗留执行修复；指定会话仍为 `running` 时该操作返回 409，不阻塞其他会话，也不自动重放。本地 SQLite 通过持久恢复标记和索引修复遗留 Turn / Activity；首次升级会迁移旧数据并创建索引，此后启动不保留全量元信息数组。
- Runtime 的 `listSessions` 默认每页 50 条，接受 `limit/cursor`，返回 `nextCursor`；过滤使用 `assistantId/includeSubagents`。按 ID 装载在实例内合并，列表与执行缓存独立。更新会话会改变分页位置，分页不是跨写入的固定快照；刷新列表时从第一页重新读取。`listSessionMetadata()` 是显式全范围管理扫描，供本地配置引用检查使用，不用于云端常规查询或启动。
- `saveSession` 的 `tree.nodes` 是待提交的新节点，`tree.leafId` 是提交后的分支叶子；不要把 `messages` 再保存为第二份完整正文。消息节点、叶子、revision、压缩状态与必要运行状态应原子提交；导入替换同样必须原子完成。必须保留可选 `turnCheckpoint`，并在终态提交时允许清除，不能在元信息映射中丢弃该字段。
- `SavedSession.permissionGrants?: PermissionGrant[]` 保存当前执行会话已批准的精确范围；`saveSession/readSession` 及元信息映射必须保留它，批准记忆先保存成功才放行工具。本地 SQLite 复用会话 JSON 元信息，不新增表或列；自定义 Store 不得因字段筛选丢失授权。
- 保存失败必须 reject；运行时不会启动尚未成功提交的用户回合，并停止接受后续写操作。云端事务和并发冲突检测由适配实现负责；当前骨架不提供多实例抢占或恰好一次执行保证。
- 父指针决定消息路径，seq 用于排序与分页；保留稳定节点 ID、历史分支、导入原文、图片和工具结果。`readHistory` 从选定叶子向上读取 `limit + 1` 个候选节点后停止，`readWorkingPath` 只遍历到 `firstKeptEntryId` 与可选 `turnStartEntryId`；读取工作窗口不能退回全量加载。显式的 `readPath`、`readTree`、导出仍是完整读取。详细数据语义沿用 [历史存储 SPEC](specs/history-storage.md)。
- `readTurnPath(id, inputEntryId, leafId?)` 从指定叶子沿父指针读取到 Turn 输入即停止，不先遍历全部祖先再过滤；首节点作为局部根节点返回，保留原 ID 和 seq，不改写持久父指针。输入缺失或不在选定分支时返回 `{ leafId, nodes: [] }`，保留选定叶子；叶子缺失及数据库读取错误仍 reject。共享判定将无效路径判为不可恢复；SQLite 失败修复可回读 `readPath`，显式恢复则拒绝执行，不自动切换分支。该接口不限制当前 Turn 本身的长度或字节数。
- `readHistory(id, { limit, beforeSeq?, leafId? })` 必须在存储查询中按父指针和游标限制遍历，返回最多 `limit` 条正文及 `nextBeforeSeq`；达到页大小后不继续读取更老节点。`beforeSeq <= 1` 直接返回空页。分页只限制普通读取，不改变显式完整导出和树管理操作。

助手定义和 runtime 注册表由产品宿主提供。`hostRuntimes` 可传入启动快照，`saveHostRuntimes` 可在注册更新时先保存；省略后者时注册只驻留内存，由宿主在重启后重新注册。注册是当前实例范围内的完整替换，不能直接暴露为跨租户的共享注册接口。

运行中发布的新 `runtime.skills` 会在当前工具批次结束、下一次模型调用前生效；本地助手的插件挂载使用相同边界。Runtime 保留 Agent、Turn、历史、MCP 连接及已加载的延迟工具，只刷新 Skill 索引、`skill_search` 和 `skill`，仍遵守本轮 `toolAvailability`。宿主安装工具应先准备资产并挂载到当前助手，再等待 `registerHostRuntimes` 成功（该调用会等待 Host MCP 预热）后返回；无需额外 submit、steer 或重启。其他配置在下一 Turn 准入时完整应用，`assistantRevision` 继续表示该完整版本。

`turnCheckpoint.turnSystemPrompt` 保存本轮附加系统上下文；技能简介不进入 system，与宿主可选的 `runtime.capabilityCatalog`（最多 16000 字符）合并为隐藏 user 消息。首次或可见历史中的清单变化时追加完整替换清单，未变化沿用历史，删空明确发布空清单，压缩丢失清单后重新提供。发布比较依赖持久消息的 metadata，不依赖进程内标志；自定义 Store 须保留消息块的 synthetic/metadata 和 checkpoint 可选字段。在下一次模型调用前保存最新 runtime 与消息；保存失败阻止继续调用模型，不重放已经完成的安装工具。实现与验证见 [Skill 刷新 SPEC](specs/skill-hot-reload.md)。

## 事件、隔离与生命周期

- `submitTurn` / `resumeTurn` 返回 `TurnReceipt`：包含会话、Turn、可选 request ID，以及 `accepted / started / settled`。启动表示已发起本实例的执行，不表示模型完成；用 `turn.settled` 或 `waitForTurn` 读取实际结果。
- `waitForTurn(sessionId)` 等待调用时取得的本实例 Turn 执行 Promise 并返回完整快照。正常完成不等待后台作业；显式取消则等待本轮所属的本地 Shell 作业清理，不沿通信关系等待或停止对端。不等待其他 Turn 的作业、后续通知引发的 Turn 或外部持久任务。`turn.settled` 同样只报告当前 Turn；下一轮准入仍以 `execution.actions.submit` 为准。
- 普通模型重试通过 `model.retry` 事件携带 `event: { type: "model.retry", retryId, status, attempt, message, next? }`，`status` 为 `started/completed/failed`；同次模型调用保持稳定 ID，不同模型调用各用新 ID。仅 `started` 带下一次尝试的 Unix 毫秒时间 `next`；终态先于 `turn.settled` 发布。事件归属发布时固定的 `sessionId/turnId/snapshot.turn`，可用 request/canonical 身份区分共用 native Turn 的 Steer；关闭压缩不影响通知。重试状态不替代 Turn 结果，取消等待时重试为 `failed`、Turn 仍为 `cancelled`。
- `listBackgroundJobs(sessionId)` 返回 `{ instanceId, sessionId, jobs }`，只查会话元信息和进程内作业表，不读历史；Local 同名透传，HTTP 对应 `GET /sessions/:id/jobs`。`jobs` 包含直接拥有的本地 Shell 作业及近期终态，不把助手通信登记成内存作业；每项只有身份、类型、标题、状态、起止时间及可选错误。标题/错误分别截至 512/2048 字符，不含输出正文和任意 details。标题可能来自命令，摘要不提供脱敏保证。
- 作业观察是读取瞬间的事实，不属于会话 revision 投影，不消费结果、不确认通知。它不汇总后代，不查询外部持久执行器，也不是完整作业历史；重启后以新 `instanceId` 观察空表，不能推断旧进程副作用已停止。宿主应区分本轮已结算、直接作业仍运行及业务目标完成，不能把空表当成所有工作完成。父会话删除也会拒绝尚有活跃本地作业的子会话。
- `TurnInput.canonicalTurnId` 可选，非空且最多 256 字符，原样保存到 Turn、快照、事件和回执。有 canonical 时按当前 native Turn 的原始身份或 `steerAdmissions` 去重，且必须绑定同一原 requestId，否则返回 409；不同 canonical 即使 requestId 相同也作为新轮准入。Steer 保留 native Turn ID 与 `rootCanonicalTurnId/rootRequestId`；`turn.canonicalTurnId/requestId` 只代表实际消费输入的 owner，受理入队不覆盖它。受理回执的 `replacesCanonicalTurnId` 指向最近受理者，`turn.applied` 中 Turn 的前驱指向实际被接替者；宿主只在 applied 后完成执行交接，不把 handoff 当成 native cancelled。
- `SteerReceipt` 在受理时返回 `queued: true, applied/started: false, settled: false, durable: false` 与本条 `admission`。`Turn.steerAdmissions` 按受理顺序保留 `canonicalTurnId/requestId/replacesCanonicalTurnId`、`status: queued|applied|settled`、`applied`、时间及终结原因；同身份重试查询当前记录，不追加消息。消费 user 消息时，在同次存储提交保存历史、实际 owner 与 applied，再发布 `turn.applied`，顶层 `steerAdmission` 指明本条。连续队列逐条应用，两种 Agent 队列模式均保留输入顺序。
- 取消、失败或关闭后逐条发布 `steer.settled`，顶层 `steerAdmission` 带 `stopReason`；尚未消费时 `applied: false`，不得据此 guided 旧 owner。模型错误不隐式重启队列；清空未消费消息，下一 Turn 不重放。冷装载将遗失的 queued 记录结算为 `interrupted`，不宣称队列恢复。记录只在当前 native Turn 范围内保留，不是持久消息队列或跨 Turn 幂等表。命中原始 submit 身份的 steer 重试返回 `applied: true, queued: false`，不伪造 steer admission。未提供 canonical 时保留 requestId 去重；`cancelTurn` 的 `cancellationRequested/durable` 不表示外部副作用已撤销。
- `SessionSnapshot.execution.actions` 与四个控制入口共用 Runtime 决策；它描述新操作，不预留准入资格，也不替代宿主权限。相同取消请求复用在途确认，终态取消是 `accepted: false` 的无操作；`resume` 可用只允许进入恢复预检，历史或账本不符返回 `recovery_validation_failed`，外部执行器缺失或任务仍运行分别返回 `external_executor_unavailable / external_job_running`。`RuntimeError.reason` 与 HTTP 错误的 `reason` 使用同一稳定代码，身份不符为 `turn_mismatch`。
- `steer` 与投影复用同一准入规则，并在持久化、Agent 装载等异步等待后再次校验；取消已请求或仍在清理时拒绝追加输入，迟到输入不会进入下一 Turn。
- Steer 回执在同步排队准入时固定身份和 admission，后续应用、取消或结算可能先于 HTTP 回执到达。排队后的保存失败仍返回 503，不能据此推断未受理；当前实例 snapshot/SSE 的 `turn.steerAdmissions` 可精确核对 queued、applied 和 settled，普通新操作因存储屏障拒绝。队列继续是 `durable: false`，重启后不能用身份记录推断消息仍在。
- HTTP 会话 SSE 用最近 50 条消息的快照启动，后续发送增量；每个全局包保留 `snapshot: { turn, execution }`，`turn.applied / steer.settled` 保留顶层 `steerAdmission`，不包含完整历史或 assistant partial。每次发布同步固定 `revision / execution / turn / leafId`；异步完整快照和有界快照都读取该叶子，存储等待期间不以旧 revision 暴露新的执行摘要。跨会话写入失败会为已装载会话发布新的禁用摘要；卸载后保留整数版本水位，重新装载不复用旧版本。相同 `instanceId / sessionId / revision` 的摘要与会话流、全局流一致。
- `await subscribe(...)` 装载目标元信息并返回取消订阅函数；`subscribeAll(...)` 仍同步返回。两者不自动发送初始快照。需要全局重连对齐时使用 `await subscribeExecutions(sessionIds, next)`：1–200 个已授权会话 ID，首包 `execution.baseline` 含实例 ID 与各会话的 `sessionId / revision / turn / execution`，随后只发送指定会话高于基线水位的事件。装载元信息后，订阅、基线捕获和交付之间没有异步等待，先前的变化直接由基线覆盖，不积压冷读取期间的内容事件；不读历史、不扫描全部会话、不持久重放。HTTP 对应 `GET /events?sessionId=A&sessionId=B`，无参数 `/events` 仍只发送后续全局事件。订阅回调不应阻塞或抛错，异步投递与背压由宿主承担。
- `cancelTurn` 需要当前 `turnId`，确认回复用 `replyInteraction`，运行中追加输入用 `steer`。活跃 Turn 的取消在内存中校验身份后立即向 Agent / MCP 和本轮所属的本地 Shell 发出停止信号，不等待普通命令队列、历史读取或持久化；重复请求复用同一取消操作。先前正常结束 Turn、其他会话和通信对端的作业不受影响。所属作业的完成通知被抑制，取消结算等待其清理，见 [后台作业取消 SPEC](specs/background-job-cancellation.md)。取消确认仍等待意图保存与必要清理，外部任务仍先保存意图再请求执行器取消；SDK / Worker 必须核对实际停止状态。
- 存储故障时普通新控制操作返回 `storage_unavailable`；显式 `cancelTurn(id, { turnId, bestEffort: true })` 只对当前活跃根 Turn 尽力停止本实例的 Agent / MCP 和所属本地作业、清空队列和交互，回执 `durable: false`。它不保存取消意图，也不请求外部持久执行器取消；终态可能因保存失败为 `failed`，不能当成可靠取消。存储正常时此选项仍执行普通持久取消。
- 当前单实例按顺序接纳普通控制操作，避免异步存储下重复提交；不同会话的模型执行可并行。活跃取消独立于该队列，其清理仍属于当前回合的生命周期屏障，下一 Turn、会话卸载和关闭不能越过；未激活会话与中断 Turn 的取消继续串行处理。此处不是分布式锁，也不是跨节点调度器。
- Local 封装直接转交 `cancelTurn`，不经过助手管理和会话读取的外层队列；关闭开始后仍拒绝新的取消请求，Runtime 继续负责取消身份校验、持久化与关闭屏障。
- 宿主可调用 `cancelBackgroundJob(sessionId, { instanceId, jobId, executionId })` 停止直接归属的本机 Shell；三项身份来自 `listBackgroundJobs`。`executionId` 每次启动重新生成，防止迟到停止误取消新执行。错误实例/执行返回 409，错误归属或未知作业返回 404。入口绕过 Runtime/Local 普通队列，存储故障后也可使用；抑制完成通知，等待作业清理后返回 `{ instanceId, sessionId, accepted, durable: false, job }`，job 是同源有界摘要。终态重复停止 `accepted: false`，不修改原 Turn 结果、不启动模型。只控制本实例直接作业，不代表停止整个 Session、通信对端、工作项或外部持久任务。关闭会等待已受理的作业停止；进程重启后不能凭旧作业表判断副作用已停止。
- Steer 受理持久化后发布新 `snapshot`，保留旧 execution owner 与 queued admission；实际应用后发布 `turn.applied`。发布队列入口固定 Turn、执行摘要、历史叶子和载荷，后续投递不读取可变 owner。`turn.settled` 发出时执行清理可能尚未结束，`actions.submit.available` 仍为 false；清理结束后再发布可提交的 `snapshot`，宿主据此发起下一轮。
- `sessionRetention` 默认 `"retain"`，本地继续复用内存中的 Agent 和工作历史；宿主可显式传入 `"release-after-turn"`，在回合结果提交、事件收尾完成后解除 Agent 和消息引用，下一轮通过 `store.readWorkingPath` 加载 checkpoint 工作窗口并重建。该策略不选择数据库，Redis / SQL 仍由宿主实现 `RuntimeStore`。
- 卸载不调用 `deleteSession`、不关闭共享 MCP / 存储。没有执行、后台工作、确认、读操作或订阅引用时，从实例缓存移除整个 Session；下一次访问通过 `readSession` 重建元信息。订阅期间保留轻量 Session，但仍回收已提交工作正文。创建、导入、分叉、分支选择和闲置元信息写入遵循同一策略。完整历史浏览和导出仍临时读取持久数据；本地 HTTP 默认完整会话列表由 Local 分页汇总，不因此预载执行对象。
- 运行中、排队输入、待确认或相关后台任务会阻止卸载；助手通信与后台完成通知沿各自的持久输入或接纳通道处理。成功、失败和取消都以最终保存成功为释放前提；写入失败保留内存并停止接受后续写入。调用方自行持有的快照不受此策略管理，也不保证 RSS 立即下降。
- 一个实例对应一个已经限定权限的运行范围；存储、模型配置和工具实现都必须来自该范围。不得把不同租户的全局配置与数据放进同一实例，再依靠请求正文里的租户 ID 做隔离。
- `close` 幂等，停止本实例的在途执行并关闭注入的 MCP 与存储；外部持久任务只解除等待，不发取消请求。不要让多个实例共享同一个有独立关闭语义的 Agent 工厂；共享数据库连接池的适配器只释放自己拥有的资源。

## 手动压缩

`runtime.compactSession(sessionId, { model? }, { signal? })` 复用已有摘要与 checkpoint 管线，等待存储和完成事件落定后返回；模型等待不占用全局控制队列。显式 model 只作用于这次摘要，不改写会话模型选择。会话运行、准备、其他写入或已有手动压缩时拒绝；取消与关闭等待持久化边界和 finally 清理，不生成普通 Turn 或消息。空历史和没有旧内容可压缩时不调用模型，不发完成事件。

共享请求/结果类型位于 `@pie/runtime/protocol`；字段、HTTP 取消与状态码以 [HTTP 契约](../packages/server/README.md#http) 为准，算法和自动压缩关系见[压缩接入](compaction-integration.md)。

## 中断 Turn 的显式恢复

`recoverInterruptedTurn(metadata, tree)` 是不执行工具、不写存储的共享判定：已提交输入或完整工具结果可标为 `interrupted`；有合法外部任务关联的未完成调用也可标为 `interrupted`，但必须先查询结果才能继续；最终 Assistant 已提交则补结算。缺少 checkpoint、未关联的未知工具或本阶段不支持的队列仍失败。它只验证历史与 checkpoint，不代替工具账本、远端任务状态或执行归属检查。

宿主先取得有效 owner 并阻断旧执行者、核对授权和工具事实，再通过 `readTurnPath` 读取当前 Turn 后缀、调用判定并原子保存返回 Turn；终态同时清除 checkpoint。之后才能让 Runtime 装载该会话；仍然返回 `running` 会被拒绝装载。空路径、断链或循环返回失败判定，不抛出路径异常；存储读取错误仍由宿主处理。后缀只用于恢复判定，继续执行仍通过 `readWorkingPath` 恢复模型工作上下文，不用后缀替代先前历史。

对 `interrupted` 调用 `runtime.resumeTurn(sessionId, { turnId })`：保持原用户消息、Turn/request ID、已应用 runtime/模型和实际 system prompt，准入保存成功后才调用模型；已完成工具不重放。对该 Turn 调用 `cancelTurn` 可以可靠取消而不构造 Agent。恢复或取消前不能直接提交下一 Turn 或替换历史。

本地 SQLite 默认保持中断即失败的行为，以免尚未支持恢复入口的 Astron 宿主被阻塞。显式设置 `PI_TURN_RECOVERY=manual` 后启用安全分类和 HTTP 恢复入口；启动不会静默调用模型。Cloud 直接使用共享契约，不读取这个本地环境变量；现有 Cloud 恢复器仍需增量适配，不因新增接口就自动获得续跑能力。完整范围见 [Turn 恢复 SPEC](specs/turn-recovery.md)。

## 外部异步任务

### 工具执行账本

所有工具调用统一归属 `Turn -> ToolExecution`，Job 只是外部执行器适配名称。普通工具和 `communicate` 默认 `inline`，旧 Task 历史保留 `delegated`，已通过 `runJob` 关联外部执行的调用使用 `durable`。外部工具可以声明 `toolExecutionMode`；这个字段不同于控制并行/串行的 `executionMode`，也不会让普通 Promise 自动获得跨实例恢复能力。

共享 Runtime 通过 Agent 的可等待事件记录调用开始，在最终后处理后的 `toolResult` 提交时记录 `completed` / `failed`；外部提交额外记录 `submission_intent` / `submitted`，结果不确定时保留 `recovery_required`。它是账本阶段，不是新的公开 Turn 状态。

Store 适配须实现新的提交与读取契约：

- `saveSession(session, replaceHistory?, toolExecutions?)`：第三个参数是本次增量事实，必须与历史节点及 Session/Turn 元信息同一事务提交；不能忽略或在提交后另写。以 `(sessionId, record.id)` 去重，身份冲突拒绝，不覆盖已经提交的事实。
- `readToolExecutions(sessionId, { turnId, limit, afterSeq? })`：按账本 seq 升序读取指定 Turn，每页 1–200 条，返回 `{ entries, nextAfterSeq }`。必须将作用域、游标和 limit 下推到存储，账本 seq 不等于历史 seq 或 SSE revision。
- 账本独立存储，终态清理 checkpoint、开启下一轮或替换历史不删除它；会话删除时清理。常规会话元信息、HTTP/SSE 快照均不包含完整账本。Runtime 和本地封装提供同名分页读取方法，不新增 HTTP 任务平台。

`resumeTurn` 在查询外部任务前检查账本身份、历史调用/结果和 checkpoint 关联。提交响应丢失不等于没提交，重启后不会因缺少 `submitted` 就重提。账本不提供工具内部断点、自动重放或恰好一次副作用；Cloud 仍负责授权、租约和旧执行者隔离。SQLite 适配已提供独立表和原子提交，Cloud 的 MySQL/Redis 适配须增量接入，不要直接覆盖同事代码。

`RuntimeOptions.jobs` 可注入 `DurableJobExecutor`；未注入时不提供 `context.runJob`，本地 `BackgroundJobs` 和 Shell 保持独立，助手协作仍走 `communicate`。外部工具在权限确认后调用 `context.runJob(toolCallId, signal)`，Runtime 从已提交的工具调用取得工具名和参数，不保存或转移执行函数。即使工具省略可选 signal，Runtime 也会关联当前 Turn 的停止信号；外部结果只承载 `content/details/usage`，不传递工具动态注册或提前终止指令。

执行器需要实现：

- `submit({ id, sessionId, turnId, toolCallId, toolName, arguments }, signal?)`：以稳定 `id` 幂等提交，返回前可靠保存任务关联。若远端分配自己的 taskId，由适配器持久映射，不能只放 Map。PIE 在调用前已经将关联保存到 `turnCheckpoint.jobs`。
- `get(reference, signal?)`：从持久事实返回同一身份的 `running / completed / failed / cancelled / unknown`；完成结果包括原始文本/图片和 details，成功状态不能缺少结果。缺失、未知或身份不匹配拒绝继续，PIE 不重新提交。
- `cancel(reference)`：可靠提交取消请求，不等于远端已停止或副作用已撤销。`signal` 只取消当前提交/查询的网络等待，不能把进程关闭解释为取消外部任务。执行器的资源和关闭由宿主管理，Runtime 不关闭共享执行器。

普通执行会查询直到任务终态；`pollIntervalMs` 默认 1000 毫秒，可设 1–60000。提交响应丢失、查询失败或服务关闭时，Runtime 保留关联和已提交历史，标为 `interrupted`，不保存由本地中止产生的虚假工具错误。

新实例先由宿主取得有效归属，再调用 `resumeTurn`。PIE 只查询未提交结果的原任务；仍运行返回 409，缺失/未知/身份不匹配也拒绝，查询故障向调用方传播。全部缺失结果明确后，结果与 Turn 准入原子提交，再用原配置调用模型。已落盘结果不重复消费，无需依赖旧实例回调或收到通知；宿主可通过通知唤醒后重复查询。

显式取消先保存意图再请求执行器；历史补入带任务身份的“取消已请求、最终结果需核对”错误结果，不能据此宣称任务已被取消。未关联的本地异步函数、助手通信自动续跑、持久确认和工具内部 checkpoint 不在本阶段范围，详见 [外部任务 SPEC](specs/durable-jobs.md)。

## 骨架验收

在仓库根目录执行：

```sh
npm run test:runtime
node --expose-gc --conditions=source --test packages/runtime/test/runtime.test.ts
```

使用延迟存储替身、注入工具与 faux 模型，覆盖无 HTTP / SQLite 的工具循环、进度、历史恢复、并发提交拒绝、写入失败、用户确认和取消，以及两种保留策略、checkpoint 重建、后台通知和历史分支。助手通信另由真实 Runtime、Scheduler 和 SQLite 回归覆盖。第二条命令额外用 WeakRef 与显式 GC 验证 Agent 和工作正文可回收；不以 RSS 变化代替引用验证。不使用真实云端服务或付费模型；这不替代第二阶段的云端闭环验收。
