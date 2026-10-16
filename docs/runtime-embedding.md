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
const unsubscribe = runtime.subscribe(session.id, (packet) => {
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

- `loadSessions` 只返回当前授权范围的会话元信息；正文通过 `readPath`、`readWorkingPath`、`readTree` 或 `readHistory` 按需读取。适配实现须完成所属会话的启动恢复；如仍返回 running 回合，运行时拒绝启动并释放资源，不自动重放。本地 SQLite 继续使用已有恢复流程。
- `saveSession` 的 `tree.nodes` 是待提交的新节点，`tree.leafId` 是提交后的分支叶子；不要把 `messages` 再保存为第二份完整正文。消息节点、叶子、revision、压缩状态与必要运行状态应原子提交；导入替换同样必须原子完成。
- 保存失败必须 reject；运行时不会启动尚未成功提交的用户回合，并停止接受后续写操作。云端事务和并发冲突检测由适配实现负责；当前骨架不提供多实例抢占或恰好一次执行保证。
- 父指针决定消息路径，seq 用于排序与分页；保留稳定节点 ID、历史分支、导入原文、图片和工具结果。读取工作窗口时遵循已有 checkpoint 边界，不能退回全量加载。详细数据语义沿用 [历史存储 SPEC](specs/history-storage.md)。

助手定义和 runtime 注册表由产品宿主提供。`hostRuntimes` 可传入启动快照，`saveHostRuntimes` 可在注册更新时先保存；省略后者时注册只驻留内存，由宿主在重启后重新注册。注册是当前实例范围内的完整替换，不能直接暴露为跨租户的共享注册接口。

## 事件、隔离与生命周期

- `submitTurn` 返回已接纳的 turn 标识；不等于模型完成。用 `turn.settled` 或 `waitForTurn` 判断终态；运行时仍使用同一份 Agent Loop。
- `subscribe` / `subscribeAll` 返回取消订阅函数，不自动发送初始快照，也不持久重放事件。宿主可用 `getSession` 读取快照；订阅回调不应阻塞或抛错，异步投递与背压由宿主承担。
- `cancelTurn` 需要当前 `turnId`，确认回复用 `replyInteraction`，运行中追加输入用 `steer`。取消只是向工具传递信号；SDK / Worker 必须核对实际停止状态。
- 当前单实例按顺序接纳控制操作，避免异步存储下重复提交；不同会话的模型执行可并行。此处不是分布式锁，也不是跨节点调度器。
- `sessionRetention` 默认 `"retain"`，本地继续复用内存中的 Agent 和工作历史；宿主可显式传入 `"release-after-turn"`，在回合结果提交、事件收尾完成后解除 Agent 和消息引用，下一轮通过 `store.readWorkingPath` 加载 checkpoint 工作窗口并重建。该策略不选择数据库，Redis / SQL 仍由宿主实现 `RuntimeStore`。
- 卸载保留会话元信息、当前叶子、checkpoint 和订阅，不调用 `deleteSession`、不关闭共享 MCP / 存储。创建、导入、分叉、分支选择和闲置元信息写入也会回收已提交的工作正文。完整历史浏览和导出仍临时读取持久数据。
- 运行中、排队输入、待确认或相关后台任务会阻止卸载；Subagent 先提取结果再释放，后台完成通知进入同一接纳通道。成功、失败和取消都以最终保存成功为释放前提；写入失败保留内存并停止接受后续写入。调用方自行持有的快照不受此策略管理，也不保证 RSS 立即下降。
- 一个实例对应一个已经限定权限的运行范围；存储、模型配置和工具实现都必须来自该范围。不得把不同租户的全局配置与数据放进同一实例，再依靠请求正文里的租户 ID 做隔离。
- `close` 幂等，取消在途执行并关闭注入的 MCP 与存储。不要让多个实例共享同一个有独立关闭语义的 Agent 工厂；共享数据库连接池的适配器只释放自己拥有的资源。

## 骨架验收

在仓库根目录执行：

```sh
npm run test:runtime
node --expose-gc --conditions=source --test packages/runtime/test/runtime.test.ts
```

使用延迟存储替身、注入工具与 faux 模型，覆盖无 HTTP / SQLite 的工具循环、进度、历史恢复、并发提交拒绝、写入失败、用户确认和取消，以及两种保留策略、checkpoint 重建、Subagent / 后台通知和历史分支。第二条命令额外用 WeakRef 与显式 GC 验证 Agent 和工作正文可回收；不以 RSS 变化代替引用验证。不使用真实云端服务或付费模型；这不替代第二阶段的云端闭环验收。
