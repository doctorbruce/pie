
# Pie 本地 / 云端统一 Loop 演进

状态：进行中，第一阶段源码骨架、runtime / local / server 包级拆分与 Cloud 五包源码接入已完成；发行与真实云端宿主装配、后续云端实现待完成。更新日期：2026-10-15。

## 问题与目标

让 Pie 成为本地与云端共用的 Agent 运行时。Astron 的产品宿主在本地是 `astronverse-agent`，在云端是 `agent-service`：两者职责对应，分别衔接产品入口、产品状态与底层运行时，不只是协议转发层。启用 Pie 时，本地通过现有 HTTP / Sidecar 接入，云端通过可复用包接入。

Session、Turn、上下文、模型调用、Subagent 和 Loop 只维护一份实现，存储、工具执行和配置来源由宿主注入。这里要求的是两端共享 Pie，不要求把现有 Python `astronverse-agent` 整体移植到云端，也不要求本地改成进程内包调用。

例如，同样是“读取附件并执行 APA”，本地从 SQLite 读取会话、调用本机执行能力；云端从服务数据库读取会话、通过 tools-sdk 调用执行端。两者运行同一套决策与上下文逻辑，不在 Loop 内到处判断 `local / cloud`。

统一 Loop 指复用运行时能力，不是所有用户共用一个上下文，也不是“一套 Agent 对应一台用户 VM”。纯聊天和可信业务 API 不必创建用户执行 VM。

## 当前基础与差距

- `packages/agent` 继续负责底层 Loop；`packages/runtime` 承载可直接调用的会话运行逻辑与能力契约，通过 `@pie/runtime`（或根仓库 `pie/runtime`）导出。根入口仍导出 Agent Core，不再从 Server 导入运行模块。
- `packages/local` 装配 SQLite、本机工具、文件模型配置、Skill / MCP 和本地助手管理；`packages/server` 只做 HTTP / SSE、CLI / Sidecar。本地默认值和数据格式保留，Runtime 不依赖这两个包；异步 `RuntimeStore` 与模型 / 工具 / Skill / MCP / 请求记录的真实云端实现仍待开发。
- `cowork3/cloud` 已有 Fastify `agent-service` 入口与 `Svc` 装配位置；`tools-sdk`、`protocol`、`tools-service` 和 `vm-worker` 目前只有包配置，不能当作已可用的调用链。
- SQLite 本身也是数据库；这里的存储演进是从本机文件数据库，变成可替换的服务数据库实现，不是简单把 SQLite SQL 换个地址。

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

- 为工具执行保留稳定标识、执行端归属和持久结果，区分执行中、成功、失败、已取消与结果未知。网络重试沿用原调用身份；工具调用 ID 本身不提供副作用去重保证。
- 有副作用的动作不因超时或重启盲目重试；结果未知时先向执行端核对，再决定继续、重试或交给用户。初期可以不自动恢复执行，但必须保留历史和未知状态，不能声称恰好执行一次。
- 云端对外开放前具备身份认证、租户授权、Worker 身份、凭据隔离与资源配额。长任务、确认、设备离线的持久等待，以及事件续读按阶段补齐。
- 首先用单进程保证会话单一所有者；多实例阶段再建立可校验的会话归属和接管机制，避免两个节点同时推进。已有历史按需读取与后续内存回收继续沿用对应 SPEC，不另建一套存储设计。

## 推进顺序与验收方向

| 阶段 | 范围 | 验收方向 |
| --- | --- | --- |
| 第一阶段：可嵌入与本地等价 | 提取运行模块，注入本地存储 / 工具 / 配置实现，明确云端包接入方式 | 导入运行模块不监听端口、不擅自创建本地库；宿主可直接驱动一次工具循环并收到事件；本地分支、压缩、Subagent、确认与取消行为保持 |
| 第二阶段：单租户云端闭环 | `agent-service` 装配服务数据库与 tools-sdk 适配，复用一个远端 Astron Worker / 现有 VM | 不改 Loop 即切换持久化和执行实现；纯聊天不建 VM；同一 Turn 完成真实浏览器操作、APA 执行、进度与结果回传；重启可读历史，未知动作不自动重放，本地仍可用 |
| 第三阶段：云端可交付 | 租户 / 应用隔离、资产部署、执行记录、确认与取消、配额 | 两个租户不串配置、消息、文件或凭据；一个宿主更新不删除其他宿主配置；跨租户访问被拒绝，断连可核对执行结果，高风险动作不因重试重复执行 |
| 第四阶段：规模化与多设备 | 多实例归属与接管、持久等待、事件续读、按需执行资源、本地设备 Worker | 节点接管不双执行；设备离线可等待，确认与结果可续接；本地与云端共享工具契约，冷会话不随总会话数全部常驻 |

第一阶段用现有回归和替身依赖验证装配边界；第二阶段才要求真实云端数据库与 SDK / Worker 链路，不能用健康检查或模拟工具代替云端闭环验收。数据库选型在该阶段明确，不提前绑定。

## 包级拆分范围与不做

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
