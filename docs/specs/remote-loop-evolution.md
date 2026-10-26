
# Pie 本地 / 云端统一 Loop 演进

状态：进行中。Pie 侧的包级拆分、闲置正文卸载、会话增量事件、按 ID 装载、Turn 恢复边界、有界历史读取和外部任务关联接管已完成；统一工具执行账本延续 Turn 恢复阶段，验收状态见对应 SPEC。Cloud 适配、联合恢复与生产级资源验收仍待推进，以本地回归作为交付门槛。更新日期：2026-10-26。

## 问题与目标

让 Pie 成为本地与云端共用的 Agent 运行时。Astron 的产品宿主在本地是 `astronverse-agent`，在云端是 `agent-service`：两者职责对应，分别衔接产品入口、产品状态与底层运行时，不只是协议转发层。启用 Pie 时，本地通过现有 HTTP / Sidecar 接入，云端通过可复用包接入。

Session、Turn、上下文、模型调用、Subagent 和 Loop 只维护一份实现，存储、工具执行和配置来源由宿主注入。这里要求的是两端共享 Pie，不要求把现有 Python `astronverse-agent` 整体移植到云端，也不要求本地改成进程内包调用。

例如，同样是“读取附件并执行 APA”，本地从 SQLite 读取会话、调用本机执行能力；云端从服务数据库读取会话、通过 tools-sdk 调用执行端。两者运行同一套决策与上下文逻辑，不在 Loop 内到处判断 `local / cloud`。

统一 Loop 指复用运行时能力，不是所有用户共用一个上下文，也不是“一套 Agent 对应一台用户 VM”。纯聊天和可信业务 API 不必创建用户执行 VM。

演进目标不是只让 `agent-service` 适配现有本地对象，也不是把所有生命周期交给宿主重写：Pie 自身应支持按指定会话装载、可靠提交后回收、从外部状态重建，以及不随历史长度放大的常规事件投递。本地继续使用同一实现和本地适配，不为云端维护第二套 Loop。

## 当前基础与差距

- `packages/agent` 继续负责底层 Loop；`packages/runtime` 承载可直接调用的会话运行逻辑与能力契约，通过 `@pie/runtime`（或根仓库 `pie/runtime`）导出。根入口仍导出 Agent Core，不再从 Server 导入运行模块。
- `packages/local` 装配 SQLite、本机工具、文件模型配置、Skill / MCP 和本地助手管理；`packages/server` 只做 HTTP / SSE、CLI / Sidecar。Runtime 不依赖这两个包；本地默认使用 `retain`，云端可选择 `release-after-turn`，已有能力见 [卸载 SPEC](idle-session-release.md) 和 [事件 SPEC](session-event-stream.md)。
- 按 2026-10-23 本地工作树核对，`cowork3/cloud/apps/agent-service` 已有 MySQL 会话存储、对象存储载荷、按用户认领的租约、写入代次校验、Redis 跨实例路由与保守恢复，工厂已启用每轮卸载。它不再只是包接入骨架，但真实工具、配置跨实例协调及生产联合验收不能由源码存在推定完成；以 Cloud 对应 SPEC 和验收记录为准。
- 共享 Runtime 已移除启动 `loadSessions()`，改为按 ID 读取元信息和游标分页；执行缓存只含已访问会话，`release-after-turn` 可回收整个空闲 Session，详见 [按需装载 SPEC](session-activation.md)。本地默认仍复用已访问会话；Cloud 副本和工厂尚待同步，不能据此宣称云端启动已轻量化。Session 内部仍协调配置、Agent 与执行 Promise，不为形式分层新增公共包。
- Pie 主仓的会话事件已轻量化：`agent.event` 只发送 revision 和投影增量，客户端通过 `readHistory` 补齐；Cloud 副本仍在会话事件上生成完整快照，宿主也消费完整视图。需要共享包与宿主消费者一起增量适配，不能直接覆盖目录或把 Redis 运输增量当作源头读取成本已解决。
- Pie 本地 SQLite 的普通历史分页和压缩工作窗口已改为有界父链查询；完整树、导出和显式全量快照仍保留为管理操作。Cloud 适配必须把同样的边界下推到数据库查询，不能先加载整条路径再在服务层切片。
- SQLite 本身也是数据库；这里的存储演进是从本机文件数据库，变成可替换的服务数据库实现，不是简单把 SQLite SQL 换个地址。
- 执行事实统一归属 `Turn -> ToolExecution`；Job / Task 不新增顶层恢复模型。最小账本记录开始、外部提交意图、提交确认及确定结果，独立持久化并按 Turn 分页，不放入会话快照。沿用已有 checkpoint 与执行器，详见 [Turn 恢复 SPEC](turn-recovery.md)；Cloud Store 须接入原子增量写入和账本查询，不能只搬类型或将本地 Promise 当作持久状态。

## 生命周期与恢复等级

| 状态 | Pie 的演进约束 | 宿主职责 |
| --- | --- | --- |
| 持久会话 | 历史节点、分支叶子、Turn 事实和压缩 checkpoint 由存储恢复，不以进程对象为唯一依据 | 授权范围、事务和外部持久化实现 |
| 工作上下文 | Agent、工作消息与能力引用可按需建立和回收；本地可跨轮缓存，不强制 Agent 与单轮一一对应 | 选择保留策略，提供模型、工具、Skill / MCP |
| 本轮执行 | 明确持有本轮 Promise、取消、配置快照与收尾责任，不能被下一轮或后台通知提前释放 | 控制命令路由到当前执行者 |
| 实例归属 | 不把云端租约、Pod 或 Redis 协议写入 Loop | 认领、续约、失租隔离、接管与进程关闭 |

目标是“回合之间可以从已提交状态重建”，不是执行期间完全没有内存状态。云端当前按 `{tenantId,userId}` 持有 Runtime 并路由请求，是一种宿主策略，不固化为 Pie 的会话或部署模型。

压缩 checkpoint 是上下文重建依据，不是工具执行断点。中断恢复先保留历史、核对工具结果并明确 failed / unknown；不序列化 Promise，不恢复旧确认，不盲目重放副作用。跨实例无损续跑、持久等待和恰好一次执行不属于下一轮改造承诺。

## 目标结构与职责

```text
目标链路（本地启用 Pie 时）：
桌面 / trigger → astronverse-agent → Pie HTTP / Sidecar → Pie Runtime
Web / IM / API → agent-service    → Pie 包调用         → Pie Runtime

cloud/
  apps/agent-service：云端产品宿主，相当于本地 astronverse-agent
  packages/pie：五个共享能力包，不是另一套产品服务
  packages/tools-sdk：工具定义、校验、可信服务端工具及执行端调用能力
  apps/tools-service / vm-worker：按工具和环境需要承担实际执行
  packages/protocol：跨进程消息；不承载 Loop 或业务状态
```

- **Pie 拥有运行语义**：会话和消息分支、Turn 状态推进、上下文与压缩、模型循环、Subagent 协调。`agent-service` 调用这些能力，不再实现第二套会话状态机或 Loop。
- **Astron 拥有产品语义**：身份、权限策略、助手配置、市场资产、知识与产品记忆。本地 `astronverse-agent` 与云端 `agent-service` 分别衔接这些能力，负责产品会话绑定、请求增强、运行时管理、事件转换与各自环境的依赖装配；不意味着把市场或账号等既有后端能力重做在宿主内。Pie 消费有效配置、执行运行约束并返回事件，不重新建设产品配置体系。
- 产品会话与 Pie 执行会话通过稳定标识绑定：宿主管助手归属、入口路由与产品展示，Pie 管消息分支和 Turn 执行事实。不在两层各自维护一套可独立推进的消息历史或执行状态机。
- **Worker 拥有执行环境**：浏览器、桌面、Excel、APA、工作区和脚本。Worker 不是另一个 Agent，Subagent 的决策仍由 Pie 管理。
- 同一运行中的会话只有一个 Loop 所有者；本地与云端复用代码，不意味着可同时推进同一任务。执行位置可以按工具选择，决策所有权不随每次工具调用迁移。

### 包接入原则

- 同意在 `cloud/packages` 下接入 Pie，但接入的是可消费的运行能力，不是把整仓复制进去后再维护一份云端分支。
- Pie 当前也是 workspace。接入时明确 Agent / AI 等实际依赖的包入口、构建与版本关系；不能假设把整个仓库嵌入 `packages/pie` 后，外层 workspace 就自动识别全部内部包。
- 从现有 `packages/server` 提取可嵌入的运行模块，保留本地 HTTP / CLI / Sidecar 作为传输与启动入口，供 `astronverse-agent` 或独立本地使用接入。它们不替代 Astron 产品宿主；云端由 `agent-service` 直接调用运行模块，不启动第二个 Pie HTTP 服务，不导入有监听端口等副作用的 CLI 入口。
- 对宿主只暴露必要操作：创建与读取会话、提交输入、取消与回复确认、订阅运行事件、关闭资源。HTTP、ACP 等协议转换留在宿主，不要求两端使用相同传输协议。
- Pie 定义自己需要的能力契约；本地实现留在 Pie，云端实现由 `agent-service` 装配并调用数据库访问层或 tools-sdk。避免 Pie 反向依赖 Astron 应用和云端 SDK。

## 优先开放的能力接口

只抽取已有本地实现与明确云端需求之间真正变化的部分，不为每个类建立一层平台接口。

| 能力 | 本地实现 | 云端实现 | Pie 保留的约束 |
| --- | --- | --- | --- |
| 会话持久化 | 现有 SQLite | `agent-service` 装配的服务数据库访问实现 | 消息树、分支、revision、分页和提交语义一致 |
| 工具提供与执行 | 现有原生工具、本机 Astron 能力 | 适配 tools-sdk，按授权路由至可信 API 或 Worker | 工具参数、结果、过程更新、确认、取消与错误语义一致 |
| 配置与模型解析 | 本地配置、宿主 runtime、环境凭据 | 租户 / 应用 / 助手配置与云端凭据解析 | 使用当前会话的模型、工具白名单和运行配置 |
| 文件与资产访问 | 本地文件、技能目录和工作区 | 文件 / 对象存储引用、资产版本与 Worker 工作区映射 | 模型可读取指引，执行端可取得附件和资源，产物可追溯 |

### 1. 存储接口按会话语义设计，调用链支持异步

- 复用 [历史存储 SPEC](history-storage.md) 的消息节点、父指针、当前叶子和按需读取设计，不退回保存完整消息 JSON，不把数据库类型、SQL 或 ORM 实体暴露给 Loop。
- 接口表达读取会话元信息、读取指定路径 / 分页历史、提交消息与运行状态等实际操作，不建设通用数据库框架。新增节点、叶子与 revision 等关联状态必须原子提交，写入失败不得假装完成。
- 云端数据库存在网络等待与失败，运行层到存储层统一按异步调用设计；本地 SQLite 可以在同一契约后保留现有实现。不能只包一层同步接口，让上层继续依赖“调用立即完成”。
- Pie 定义持久化语义，云端访问实现负责事务、授权作用域和冲突检测；并发冲突不得静默覆盖其他运行的状态。正式完成与恢复依据已提交状态，不承诺所有流式增量都可重放。
- 按租户与会话读取所需数据，不在服务启动时加载全库正文或全部租户的活跃对象。模型工作上下文、持久历史和产品知识 / 记忆仍是不同职责。

### 2. 工具接口复用现有契约，替换真实执行位置

- 复用现有 `AgentTool.execute` 的参数、结果、`toolCallId`、取消信号和过程更新契约；云端适配层把 SDK 的返回与错误转换为 Pie 可理解的工具结果，Loop 不感知网络协议或沙箱供应商。
- 不只是外部工具：原生 `read / write / bash`、后台进程和技能资源也依赖本地环境。云端逐项选择 SDK / Worker 实现或明确禁用；不能漏接后默默在 `agent-service` 主机执行。
- tools-sdk 可承载可信服务端工具；浏览器、APA 和不可信脚本进入合适的执行端。不为每次调用强制创建 VM，也不为了共用包把用户执行环境搬进共享 Loop 进程。
- 工具目录只包含该会话可用的能力，权限变更和执行目标由授权后的上下文决定。保留用户确认与回复通路；取消请求已送达不等于远端动作已经停止，超时也不等于执行失败。

### 3. 配置按作用域传入，避免全局切换

- 依赖实现在宿主启动时装配；租户、应用、Session、助手配置版本与允许的执行目标按运行传入。前者决定“接什么实现”，后者决定“这次允许做什么”，不使用一个 `cloud=true` 代替权限与隔离。
- 身份和权限来自可信宿主认证结果，不相信请求正文自报的租户。运行层只使用已限定作用域的存储、配置与凭据访问能力，不能仅靠调用方记得补一个租户过滤条件。
- 每个 Turn 使用明确的配置版本；新配置何时生效有确定规则，不能执行到一半因其他租户更新而更换模型、工具或凭据。不要通过改写进程环境变量或全局默认配置切换租户。
- 宿主注册和更新只影响自己的命名空间，不能把当前整表替换式 runtime 注册直接扩展为所有云端宿主共用的注册表。模型密钥和 Worker 凭据不进入提示词、通用事件或工具结果。

### 4. 文件与 Skill / APA 资产不绑定客户端路径

- 区分给 Loop 的技能指引和给 Worker 的脚本、依赖及资源；分别解决指引读取与执行资源部署，复用 Astron 现有资产体系，不重复建设市场。
- 跨进程传递附件、工作区和产物的可授权引用；本机或 Worker 内部再解析为实际路径。不把 `E:\...` 这样的客户端绝对路径当成云端可访问资源，也不把一个路径字符串当作授权。
- 执行包声明版本、操作系统和运行依赖；Windows、Office、浏览器登录态等需求按能力匹配执行端，不默认 Linux 沙箱能替代所有 APA 环境。

## 执行恢复与服务扩展

2026-10-24：先启动共享 [Turn 持久化与安全恢复](turn-recovery.md) 第一阶段，覆盖同一 Turn 的提交边界重建、本地显式恢复和未知工具阻断。它是本地和 Cloud 共用的能力，不表示下表 P1 按会话轻量装载、Cloud 事件对齐或分布式任务接管已经完成。

第一阶段已在 Pie 交付并通过本地回归；默认保持原中断失败策略，显式 `PI_TURN_RECOVERY=manual` 才启用本地恢复分类与操作。Cloud 仍须增量接入 checkpoint、分类及原 Turn 恢复入口，并先完成 owner、授权和工具事实核对。

- 为工具执行保留稳定标识、执行端归属和持久结果，区分执行中、成功、失败、已取消与结果未知。网络重试沿用原调用身份；工具调用 ID 本身不提供副作用去重保证。
- 有副作用的动作不因超时或重启盲目重试；结果未知时先向执行端核对，再决定继续、重试或交给用户。初期可以不自动恢复执行，但必须保留历史和未知状态，不能声称恰好执行一次。
- 云端对外开放前具备身份认证、租户授权、Worker 身份、凭据隔离与资源配额。长任务、确认、设备离线的持久等待，以及事件续读按阶段补齐。
- 首先用单进程保证会话单一所有者；多实例阶段再建立可校验的会话归属和接管机制，避免两个节点同时推进。已有历史按需读取与后续内存回收继续沿用对应 SPEC，不另建一套存储设计。
- 闲置正文释放由共享 Runtime 提供，宿主选择保留或每轮卸载；本地默认保留，云端可通过既有 `RuntimeStore` 从 Redis / SQL 重建。具体范围和验收延续 [闲置会话卸载 SPEC](idle-session-release.md)，不在 `agent-service` 复制一套会话状态机。

## 下一阶段顺序与验收

下表替代最初按云端产品交付划分的开发顺序。P1 的 Pie 侧已交付，下一步先完成 Cloud 的 P0 / P1 契约迁移，再推进 P2 / P3；云端产品、工具与生产验收仍由 Cloud 独立推进。

| 阶段 | Pie 要做的事 | 验收与状态 |
| --- | --- | --- |
| P0：基线与契约对齐 | 固定本地自动回归；列清 Cloud 共享包差异，由服务端同步改造事件消费者，不能只更新五包 | 本地基线已验证；Cloud 同步与消费端适配待实施 |
| P1：会话按需装载与执行态分离 | 按 ID 元信息读取与列表分页，避免启动依赖全量 `loadSessions()`；以活动引用保护执行，可靠收尾后按策略回收 Session | Pie 已实现，本地 Server 回归 202 项、Runtime 回归 48 项通过；Cloud Store / 工厂及订阅消费者迁移待实施，联合阶段尚未完成 |
| P2：读取、事件与缓存成本可控 | 延续工作窗口、分页和轻量事件，排查活动记录、后台任务、订阅及宿主快照的残留引用；按实测瓶颈补限制，不预建通用缓存框架 | Pie 已完成：token 事件不读完整历史，历史分页与工作窗口按边界停止，其他冷会话不增加本轮正文读取；Cloud 的快照消费者、读取计数和生产包大小仍待联合验收 |
| P3：恢复契约与故障验收 | 固化运行前恢复、写入失败与关闭的契约，与 Cloud 的归属及工具事实衔接；只有发现共享能力缺口才扩展 Runtime | 待联合验收；本地重启与云端换实例都保留已提交历史，未知工具不重发，旧拥有者不能继续提交 |

P1 改动集中于 `packages/runtime/src/runtime.ts`、`runtime-store.ts` 和本地 SQLite 适配，并增加定向测试；内部职责拆分不等于再拆公共包，不预建大量生命周期接口。列表、树、导入导出和父子会话必须保留完整语义，但列会话不能以激活所有会话为前提。本地实现及测试替身已同步新契约；Cloud 消费新版本前必须迁移适配，不增加旧接口转发层。

P1 的完成条件还包括：不预载全范围元信息也能驱动一个指定会话；并发激活不重复创建执行对象；进行中、待确认、排队输入、后台任务或提交失败阻止卸载；默认 `retain` 继续复用 Agent，`release-after-turn` 在终态提交和事件收尾后释放。仅将 `session.agent` 搬到另一个对象不算完成。

2026-10-25：完成 Pie 侧整体刷新收口。普通 `readHistory` 通过递归查询累计 `limit + 1` 个可分页节点后停止；`readWorkingPath` 只遍历到 `firstKeptEntryId` 和可选 `turnStartEntryId`，不会因冷历史长度扩大正文读取。新增长前缀查询计数回归，并保留现有会话事件增量、冷正文隔离和释放引用回归。具体契约和验证见 [历史存储 SPEC](history-storage.md)。

Cloud 工厂现有的全范围恢复和助手引用收集也要同步评估；只取消 `createRuntime` 内的全量加载，不能宣称整个云端冷启动已经按需。恢复仍须在取得归属后完成，不能为减少读取跳过遗留 running Turn 或配置引用核对。

P2 区分页条数、单条消息字节数、总缓存和显式完整读取。现有分页不保证大图片或工具结果的字节上限；后续超限处理须保留原始历史与可读取结果，不能静默截断。订阅缓冲、断线和重同步也必须纳入宿主适配验收。

2026-10-25：已完成 PIE 侧 [外部异步任务关联与结果接管](durable-jobs.md)。PIE 保存稳定任务关联，宿主执行器持久保存状态和结果；新实例查询原任务、补入结果后推进原 Turn，不重新提交，不恢复函数调用栈。此能力与原本地内存 Job 分开，Cloud 仍须实现执行器、任务归属和通知适配。

真实浏览器 / APA、租户隔离、资产部署、工具账本及 SAE 的联合验收沿用 Cloud 规划；模拟工具、健康检查和本地测试不能替代这些验收。持久等待、事件日志重放、跨实例无损续跑和本地设备 Worker 后续单独立项，不作为当前改造的前置依赖。

## 本地可用性的交付门槛

本地可用是每次共享改造的验收条件，不是永久冻结所有接口；确需破坏性变更时先确认范围，再同步迁移消费者，不靠保留旧实现或降低测试要求掩盖退化。

- 本地默认仍为 SQLite、`retain`、本地模型配置和原生 / 外部工具、Skill / MCP；不要求部署 MySQL、Redis、Worker 或云端账号，按会话装载不能增加这些启动依赖。
- 不改变本地启动与宿主接入方式，不丢失旧数据库中的节点 ID、分支、图片、工具结果、导入原文和 checkpoint；需要格式迁移时单独说明并测试原子性，不能要求用户删库重建。
- 两种保留策略运行同一套 Turn、分支、压缩、确认、取消、Steer、Subagent 与后台完成通知；配置仍在下一 Turn 生效。元信息统一改为按需读取，默认 `retain` 继续复用已访问会话；整 Session 回收仍由宿主显式选择 `release-after-turn`，不检测云端环境切换默认值。
- 每个实现阶段都先跑最小定向测试，再跑 `npm run test:server` 与 `npm run check`。改动 Agent Loop 或 MCP 协议时额外运行对应定向 Core / MCP 测试，不使用真实提供商或付费 token。
- 本地默认保留与云端卸载 / 冷装载的共同语义用同一组测试验证；允许 Agent 创建次数不同，但提交后的消息、分支、Turn 终态、工具调用次数与配置生效边界必须一致。覆盖提交失败、取消、重启、确认和前台 / 后台 Subagent，不能只测纯聊天。
- 影响模型选择、图片或提示词装配时，补跑 `node --conditions=source --test packages/server/test/agent.test.ts packages/server/test/model-override.test.ts packages/server/test/multimodal-input.test.ts packages/server/test/provider-composer.test.ts`，这些用例使用本地端点或替身。
- 自动回归不等于发行验收。用户要求构建 / 部署后，按 Bun 优先规则验证 Sidecar，并单独检查本地宿主的启动、会话列表 / 详情、流式输出、取消及再次提交；没有实际验证 Electron、真实工具或发布产物时明确标注。

共享源码以 Pie 为主线，Cloud 五包采用三方增量合并，保留服务端同事的改动；共享事件或存储接口变更必须连同 Cloud 宿主的适配和测试一起交付，不直接覆盖目录，也不把 Cloud 的版本落后通过本地主仓回退来解决。

## 已完成的包级拆分范围与不做（2026-10-15）

以下保留当时实施范围，不表示当前 Cloud 仍未实现存储或宿主管理；后续开发顺序以上文 P0–P3 为准。

- 本轮完成包级拆分：`@pie/runtime` 只包含运行语义与能力契约；`@pie/local` 提供 SQLite、本机工具、文件配置、Skill / MCP 与产品助手管理；`@pie/server` 只装配本地依赖并映射 HTTP / SSE，保留现有 CLI / Sidecar 命令。
- 运行包不得反向导入 local / server，也不得默认打开数据库、扫描工具目录或读取本地配置；宿主显式传入模型、工具、技能、MCP 与请求记录，可选提供压缩配置解析，省略时只做纯计算。本地适配保留原默认值和数据格式。
- 更新源码入口、workspace 依赖、Web / 示例及定向测试；不保留旧的 server/runtime、server/protocol、server/tools 转发入口。本轮不搬入 cloud，不增加热更新插件框架，不改底层 Loop，也不覆盖已有流式控制与工具结果改动。
- 验收覆盖独立运行包的依赖边界与嵌入测试、本地 HTTP / SQLite / 工具 / MCP / Skill / 分支 / 压缩回归、`npm run check`、锁文件一致性和 `git diff --check`；实际结果见实施记录。发行构建不在本轮范围。
- 不搬仓库，不实现云端数据库、tools-sdk、认证与租户平台，不提前宣称云端已可交付；云端 Skill 资源引用与执行端协议仍待后续细化。
- 不重写 Agent Loop，不为云端复制一套 Pie，不把整套桌面 UI 搬到云端，不为接口化拆出大量微服务或通用插件框架。
- 不预先选择数据库、ORM、消息队列、持久执行框架或沙箱供应商；先证明嵌入与执行解耦，再按真实负载演进。

## 实施记录

- 2026-10-14：新增远端统一 Loop 方向性 SPEC，未修改业务代码；当时三个阶段均待实施与验收。
- 2026-10-15：结合 Pie 与 `cowork3/cloud` 当前结构，补充可嵌入包接入、四类能力接口、异步存储语义与云端宿主装配；关键依据为 Pie 的 `server.ts`、`store.ts`、`agent.ts`、`external-tools.ts`，以及 Cloud 的 README、包配置和 `agent-service/src/svc.ts`。
- 2026-10-15：明确 `agent-service` 是云端的 `astronverse-agent`，补充两端产品宿主与共享运行时的对应链路，区分产品会话绑定和 Pie 执行会话；不要求同步重写本地 Python 服务或接入协议。
- 2026-10-15：完成第一阶段源码骨架。`runtime.ts` 提取同一份会话运行逻辑，暴露创建 / 读取会话、提交 / 取消 / steer、确认、订阅、分支与导入导出；`runtime-store.ts` 定义异步会话契约，`store.ts` 提供 SQLite 适配。产品助手与 runtime 注册来源由宿主装配，不要求云端会话库重复实现产品管理。
- `agent.ts` 增加宿主能力注入；技能活动和压缩 checkpoint 等待异步提交后再推进。控制操作、同会话写入与事件发布有序，避免异步等待期间重复接纳或重复写入。`server.ts` 复用同一运行时，不修改底层 Agent Loop。
- `runtime.test.ts` 用延迟存储替身与注入工具验证无 HTTP / SQLite 的执行、并发写入、事件顺序、确认、取消、失败与重启读取；新增入口和测试已接入包导出与测试命令。服务端开发分工、装配示例、存储语义和默认本机能力风险见 [嵌入接入说明](../runtime-embedding.md)。
- 骨架验收：在 `packages/server` 执行 `node --expose-gc --conditions=source --test test/runtime.test.ts test/server.test.ts test/fork.test.ts test/compaction-server.test.ts test/auto-compaction-server.test.ts test/store.test.ts test/working-history.test.ts test/agent.test.ts test/external-tools.test.ts test/plugins.test.ts test/mcp.test.ts test/tool-progress.test.ts test/tool-search.test.ts test/model-requests.test.ts test/model-override.test.ts test/multimodal-input.test.ts test/compaction.test.ts test/auto-compaction.test.ts test/tools.test.ts`，108 项全部通过；仅使用 faux 模型及本地模拟端点。`npm run check` 通过，含 Biome、服务与 Web 类型检查、模型数据校验；`git diff --check` 通过。未运行发行构建或付费模型。
- 相对原方案：先增加“可嵌入与本地等价”前置阶段；本轮交付其源码骨架，不搬入 Cloud workspace、不实现云端数据库 / SDK / 认证 / 多租户或对象存储资源协议。源码骨架已验证不等于云端可交付；第一阶段发行与 Cloud 装配验收、第二至第四阶段仍待完成。

### 2026-10-15 包级拆分：已完成

- 实际结构：`packages/runtime/src/runtime.ts`、`agent.ts`、`capabilities.ts`、`runtime-store.ts`、`config.ts`、`tools.ts`、`mcp.ts` 负责共享运行语义和契约；压缩、消息树、工具发现与通用作业状态也归 Runtime。`packages/local/src/runtime.ts`、`agent.ts` 装配 SQLite、模型文件、工具 / Skill / MCP、请求记录与本地助手 / Plugin 管理。`packages/server/src/server.ts`、`cli.ts`、`sidecar.ts` 保留本地传输和启动入口，底层 `packages/agent` 未改动。
- `createAgentFactory(options)` 的共享入口必须注入五类能力，本地工厂保留原默认装配；模型 header 解析和压缩文件读取不再泄漏到 Runtime。保留原生工具、外部工具的默认 / 延迟曝光、确认、取消与错误语义；本地资源引用检查使用不含正文的 `listSessionMetadata`。
- 更新 workspace、锁文件、Web 类型和示例导入；不保留旧 Server 子路径转发。第三方许可随工具移至 `packages/local/LICENSES`，内容哈希不变；Bun / SEA 构建脚本继续携带 `.LICENSES.txt`。接入说明见 [嵌入接入文档](../runtime-embedding.md) 与两个新包 README。
- 验证：`npm run test:server` 134 项通过；额外执行 `node --expose-gc --conditions=source --test packages/server/test/agent.test.ts packages/server/test/model-override.test.ts packages/server/test/multimodal-input.test.ts packages/server/test/provider-composer.test.ts`，12 项通过。包含 Runtime 独立嵌入 / 依赖边界、HTTP / SQLite 重启、消息树、压缩、Subagent、工具、MCP、Skill、模型请求及 Web 展示回归，不使用收费模型。
- 全目录定向回归额外发现 `session-transfer.test.ts` 的旧会话迁移用例仍提交已不支持的内联 runtime，期望 201 而得到 400；在拆分前源文件快照上独立复现同一失败，其余三个迁移用例通过。本轮不改协议或修复这项已有测试偏差；拆分新增的外部工具曝光回归已修正并通过原请求断言。
- `npm run check` 通过；锁文件已使用 `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` 刷新；`git diff --check` 通过。29 份纯迁移实现 / 测试排除导入路径和格式差异后与拆分前一致，包含原有全局流、Shell 和 webfetch 未提交改动。
- 偏差与未完成：采用静态函数装配，不建设通用插件框架；本地 CLI / Sidecar 命令与 SQLite 格式不变。本轮未搬入 `cowork3/cloud`、未构建或部署 Sidecar，发行与 Cloud workspace 消费方式、真实数据库 / tools-sdk、资源引用和多租户验收仍待后续阶段；未提交或推送。

### 2026-10-15 Cloud 共享包接入：已完成

- 目标与范围：只将当前工作树的 Runtime / Agent / AI / Telemetry / MCP 五个包放在 `cowork3/cloud/packages/pie/{runtime,agent,ai,telemetry,mcp}`，保留包内源码、测试、许可与模型目录数据，以及必要的共享配置和接入说明；不保留整仓外壳、Local / Server / Web、仓库文档和示例。不移动或裁剪原 Pie 仓库，不复制 `.git`、密钥、会话、依赖、缓存或构建产物。
- 实现：五个能力包由 Cloud workspace 统一管理，内部依赖强制使用本地 workspace；同步调整包内配置相对路径。`agent-service` 依赖 Runtime 和 MCP，承担宿主装配，不另建 Server 包或动态插件系统。通过包解析、干净目录断言、嵌入与 MCP 协议回归验证，不向 `Svc` 注入假的数据库或工具。MCP 纳入可消费能力，不默认启用 Local 的进程启动、OAuth 文件凭据或输出落盘。
- 关键文件：Cloud 的 `pnpm-workspace.yaml`、`pnpm-lock.yaml`、`tsconfig.pie.json`、`apps/agent-service/package.json` 与 `tests/pie.test.mjs`；五包来源、装配边界和验证入口记录在 `packages/pie/README.md`。四个包的构建配置改为引用同级容器的基础配置，AI 模型目录导出路径随布局调整。
- 验收：Cloud `pnpm install --ignore-scripts --frozen-lockfile`、`pnpm typecheck:pie`、`pnpm --filter @astron-cloud/agent-service typecheck` 与 `node packages/pie/ai/scripts/check-model-data.ts` 通过；`pnpm test:pie` 6 项通过，含目录与依赖来源断言；`pnpm test:mcp` 42 项通过、1 项原有 Windows 条件跳过；`pnpm --filter @astron-cloud/agent-service test` 2 项通过。未调用收费模型。
- 一致性：五包源码及公开模型数据与原工作树一致，差异限于布局配置和接入文档；逐文件核对 468 份源文件 / 资源 / 共享配置，另有两个容器说明文件，四个包配置均能解析。Git 可见 40 份公开模型 JSON；没有额外整仓目录或外部仓库链接。原 Pie 的 `npm run check` 与双方 `git diff --check` 通过，已有无关改动保留。
- 相对原方案：撤回最初的整仓复制，改为五包选择性接入；不保留多余的根清单、锁文件、文档、Local / Server / Web。严格依赖隔离发现 AI 缺少直接声明的 `@smithy/types`，在原仓库与 Cloud 同步补充固定版本 `4.19.0` 并刷新锁文件。源码安装可能提示未构建的 `pi-ai` CLI 入口，未通过删除 CLI 或擅自构建来掩盖；不影响已验证的源码消费。
- 提交验收：按用户要求分别提交原 Pie 拆分与 Cloud 五包接入，包含必要的 workspace 锁文件。原 Pie 提交排除拆分前已有的 Shell、webfetch 和全局流实验，只保留包迁移与本次装配改动；原工作树内容不回退。在隔离的待提交快照上执行 `npm run check`、`npm run test:server`（125 项通过），以及 Agent / 模型覆盖 / 多模态 / Provider 的四文件定向回归（12 项通过）。
- 不做：本轮只交付可消费的五包源码，不实现会话 HTTP API、云端数据库、tools-sdk 适配、租户平台或动态插件框架，不构建 / 部署 Sidecar，不推送。

### 2026-10-16 闲置会话卸载：已完成

- 延续历史存储、压缩正文回收和总体内存设计的释放路线；具体实现与验收见 [闲置会话卸载 SPEC](idle-session-release.md)。共享 Runtime 支持宿主显式选择每轮可靠提交后卸载并按 checkpoint 重建，本地默认继续保留内存，不增加云端专用 Loop 或存储分支。
- `npm run check` 通过；显式 GC 的 Runtime 定向测试 15 项、本地 `npm run test:server` 157 项全部通过。未实现 Redis / SQL 访问、同步 Cloud 副本、构建或部署，真实云端闭环仍待服务端接入。

### 2026-10-23 云端友好演进规划与本地基线

- 本次仅更新本 SPEC：明确 Pie 自身的按会话装载、工作上下文与本轮执行分离、资源回收及恢复等级；保留两端一套语义，不把共享会话管理下放到宿主重写。P1–P3 尚未作为本次代码实现交付。
- 核对入口：Pie 的 `packages/runtime/src/runtime.ts`、`runtime-store.ts`、`packages/local/src/runtime.ts` 与现有卸载 / 事件 SPEC；Cloud 的 `runtime-manager.ts`、`runtime-factory.ts`、`runtime-router.ts`、MySQL Store 和生命周期 SPEC。Cloud 代码现状不替代真实部署验收。
- 本地基线：`npm run test:server` 165 项通过，包含显式 GC、两种保留策略、真实 SQLite、工具、MCP、分支、压缩、取消、Subagent、HTTP / SSE 和分页；上述模型 / 提示词 / 图片四文件定向命令额外 12 项通过。使用替身或本地模拟端点，未调用付费模型。
- `npm run check` 通过（Biome 未修改文件、Runtime / Web 类型和模型数据校验）；`git diff --check` 通过。未修改运行代码、数据库格式、Cloud 工作树或本地默认值；未构建、部署或验证 Electron 实机链路。
- 相对原方案：从包级可嵌入继续推进到按会话装载及可回收执行态，并将本地回归作为每个阶段的交付门槛。Cloud 共享包同步、宿主消费端适配、核心改造和联合故障验收仍待实施，不把规划完成记为功能已完成。

### 2026-10-24 共享单会话装载：PIE 侧已完成

- `RuntimeStore` 改为按 ID 元信息查询与游标分页，Runtime 不再启动预载会话；无活动引用时，`release-after-turn` 回收整个 Session。本地继续默认 `retain`，SQLite 首次升级增加恢复标记及索引，HTTP 会话列表保持原字段和完整结果。详细范围、关键文件和偏差见 [单会话装载 SPEC](session-activation.md)。
- `npm run test:runtime` 46 项、`npm run test:server` 191 项、模型 / 提示词 / 图片四文件 12 项通过，`npm run check` 与 `git diff --check` 通过。覆盖显式 GC、未装载子会话、异步订阅、两种保留策略、SQLite 升级及现有恢复能力。
- Cloud 仍须三方增量合并共享包，适配 Store、工厂配置 / 恢复及事件消费者；当前未修改 Cloud，不表示云端冷启动、增量事件和任务接管已经交付。未构建、部署、提交或推送。

### 2026-10-25 整体刷新收口：PIE 侧已完成

- 在既有按 ID 装载、闲置释放、Session 增量事件和 Turn 恢复边界之上，补齐 SQLite 普通历史分页与压缩工作窗口的有界父链查询；完整树、导出和显式全量快照保持原语义。
- 新增长历史前缀的 SQLite 递归访问计数回归，验证 `readHistory(limit)` 只读取页大小加一的候选节点，`readWorkingPath` 只走到 checkpoint 边界；现有冷正文隔离、事件重建和释放引用回归继续通过。
- 验证：`npm run check`、`npm run test:runtime`（48 项）、`npm run test:server`（202 项）和 `git diff --check` 通过；未构建、部署或调用真实模型，未修改 Cloud / Amio。
- 本次偏差：没有预建通用缓存、字节配额或 Cloud 兼容层；Cloud 仍需把同样的读取边界、事件消费者和资源计数以三方增量方式接入。

### 2026-10-25 外部异步任务接管：PIE 侧已完成

- 新增可选 `DurableJobExecutor` 和工具上下文 `runJob`，先持久化任务关联，再提交执行；关闭只解除等待，新实例按原任务 ID 查询，原子补入确定结果后继续原 Turn。缺失、未知或身份不匹配不重提、不推进；显式取消保留意图和未知副作用审计。
- 新增 19 项任务契约及真实 SQLite/跨进程回归，`npm run test:runtime` 51 项、`npm run test:server` 221 项、`npm run check` 与 `git diff --check` 通过。原本地工具、MCP、压缩、分支、Subagent 与两种保留策略继续通过回归。
- 此处不是自动恢复原内存 Job 或远端函数内部进度。生产执行器、幂等映射、共享任务结果、租约与通知仍由 Cloud 接入和验收；未修改 Cloud/Amio，未构建、部署、提交或推送。
