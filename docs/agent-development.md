# Pie Agent 开发文档

本文记录 Pie 当前实现和下一步开发边界。修改助手、会话、执行、事件或存储行为时，同步维护本文；HTTP 字段细节见 [服务协议](../packages/server/README.md)。

## 目标与分层

Pie 是可以独立启动的 Agent Core 服务。Web 客户端用来开发和验证 Core；Astron Cowork 已通过官方 `pie` adapter 接入会话、Turn、事件和跨 Core 历史同步。

```text
Web 客户端（React + assistant-ui）
  │ HTTP 请求向下，SSE 快照和事件向上
  ▼
packages/server
  ├─ Assistant：可复用的助手配置
  ├─ Plugin：本地 Skill 包，按助手挂载
  ├─ RuntimeConfig：提示词、工具、带来源的 Skill 和可调用 Assistant 绑定
  ├─ external-tools.ts：加载宿主提供的工具文件，按会话创建 AgentTool
  ├─ Session：助手归属与已应用版本、标题、消息、模型选择、运行配置
  ├─ Activity：Skill 加载及 Plugin 来源的持久记录
  ├─ Turn：一次用户提交的执行状态
  ├─ store.ts：SQLite 持久化与中断恢复
  └─ agent.ts + skills.ts：消费运行配置，注册带来源记录的工具
        ▼
packages/agent：Agent 实例 → agent loop → 工具执行
        ▼
packages/ai：模型目录、协议适配、流式响应和凭据解析
```

当前服务层同时承担独立 Web 客户端的本地配置管理和 Core 运行职责。原版 `Agent` 拥有一次会话的运行状态与输入队列；loop 负责模型与工具之间的循环。`packages/agent` 不依赖 HTTP、数据库、React 或 Astron 产品对象。接入 Astron 时，产品配置和插件资产仍由 Astron 管理，具体边界见下文。

## Assistant、Session、Agent 和 Turn

| 对象 | 当前字段/职责 | 生命周期 |
| --- | --- | --- |
| Assistant | `id/name/systemPrompt/toolIds/pluginIds/subagentIds/createdAt/updatedAt`；不保存消息或 API key | 本地持久化，可被多个会话引用 |
| Session | `kind/assistantId/assistantRevision/runtimeSource/title/mode/provider/model`、父会话/工具调用引用、已应用运行配置、完整消息、技能记录、最近一次 Turn | 根会话从创建到显式删除；子会话随父会话删除 |
| Agent 实例 | 配置后的模型、提示词、工具、消息、取消信号、运行状态 | 创建会话时构造；配置版本变化或重启后按需重建 |
| Turn | 用户一次提交：`running/completed/cancelled/failed` | 一次提交可触发多轮模型响应和工具调用 |
| loop | 模型响应 → 执行工具 → 把结果交给模型，直到结束 | 每次执行时运行，完成后释放运行状态 |

例如，写作助手下的“周报”和“方案”两个会话使用同一份助手定义，各自有独立的消息历史和 Agent 实例。同一会话同时只能执行一个 Turn，重复提交返回 `409`；不同会话在同一 Node 进程中异步并发，不是一会话一进程或一线程。

Assistant 是角色配置，Pi 的 `new Agent()` 是运行对象。宿主可以把其他 Assistant 作为 Subagent 绑定交给当前 Session；模型通过普通 `task` 工具派发，服务再为目标角色创建新的 Session 和 Agent。

### 配置何时生效

1. 服务首次启动自动创建“默认助手”，`toolIds`、`pluginIds` 和 `subagentIds` 为空。十个内置工具均已注册，默认启用集合后续再定。
2. 本地会话保存 `assistantId`、已应用的 Assistant 版本和解析后的 `runtime`（提示词、工具、技能路径、来源绑定和可调用助手）。每次 Turn 准入前重新读取当前 Assistant 及目标 Assistant；版本或 runtime 变化时保留消息并重建 Agent。正在运行的 Turn 使用受理时配置，下一次提交才应用后续修改。
3. 宿主启动 Pie 后用 `PUT /host-runtimes` 注册全部 Assistant runtime，配置刷新时事务性替换注册表。创建 Session 只提供 `assistantId`；每次 Turn 准入时，Pie 从注册表解析该 Assistant 及其 Subagent 的最新版本。Turn 只额外接收时间、记忆、附件等本轮动态 `systemPrompt`，不重复传稳定 runtime。
4. 模型在新建会话时独立选择，省略时使用提供商配置的默认模型。模型选择不放进 Assistant，也不把凭据复制进助手或会话记录。
5. 已有 Agent 保留创建时的模型调用配置。Assistant/runtime 变化或服务重启导致重建时，使用会话保存的 `provider/model` 从当前 `models.json` 重新解析端点、凭据和模型参数。
6. 模型被移除或配置失效时，历史仍可查看；继续执行明确报错，不悄悄切换到其他模型。修好配置后可以再次提交。

助手支持提示词、注册工具和插件挂载。`toolIds` 的过滤实际作用于模型可见的工具列表及 loop 可执行的工具集合；有 Skill 绑定时额外提供 `load_skill`。启用命令工具或 `task` 时，`job_output/job_kill` 自动随之启用。当前提供 server 层确认型交互和工作区边界检查，尚无进程沙箱或 MCP。

## Plugin 与 Skill

本节描述当前独立运行模式：Pie 自己导入插件、保存副本并管理助手挂载。它用于本地开发验证，不代表接入 Astron 后也要复制一套插件管理服务。

Pie 只把 Plugin 看作 Skill 包，不建立 APA、App 领域对象。例如，一个插件的 `apa.report.skills.summary.path` 指向 `apa/report/skills/summary`，Pie 从这个路径读取 Skill；Skill 要求执行 `uv run ...` 时，直接通过系统命令工具执行，不进入专门的 APA 调度器。

```text
本地 plugin.json + 文件目录
  → POST /plugins/import → 校验、复制到 PI_DATA_DIR/plugins/<id>
  → Assistant.pluginIds → 创建 Session 时复制挂载关系
  → plugins.runtime() → 解析为带来源的 RuntimeConfig，写入 Session
  → Agent systemPrompt 只包含 Skill ID、description 和来源名称
  → 模型调用 load_skill → 读取完整 SKILL.md 和实际目录
  → read / bash / powershell
  → 原版 loop 把工具结果交回模型
```

对齐 Astron 当前 `schemaVersion: 1` 包结构：读取根 `skills` 与 `apps.*.skills`、`apa.*.skills`，所有 `path` 都相对插件根目录；尊重模块和 Skill 的 `enabled: false`。不扫描未声明的 Skill，不按模块路径拼接 Skill 路径。Skill 的运行名称来自 `SKILL.md` YAML frontmatter 的 `name`，用途来自 `description`，支持 YAML 多行描述。插件内部名称不可重复；对模型暴露的 ID 为 `<pluginId>/<skillName>`，避免跨插件重名。

每个 Skill 保留 Plugin 来源 `source`：`pluginId/pluginName/pluginVersion?`。嵌套在 APA/App 下的 Skill 同样归属于其 Plugin；Pie 不解释这些模块的执行方式。

导入只接受直接包含 `plugin.json` 的本地目录；ZIP 先解压。保留其他 manifest 元数据与包文件，但不执行其内容。依赖目录 `.venv/venv/node_modules`、Git 和 Python 缓存不复制；不会执行安装脚本、初始化依赖或连接 MCP。使用 `uv/node/bash` 等命令的 Skill 依赖宿主已准备的工具和环境。只包含 MCP/RPA、没有已启用 Skill 的插件会明确拒绝导入。

导入先复制到临时目录，校验成功后重命名发布，失败不登记。限制 32 个插件，每个插件 128 个 Skill、10000 个文件/目录、50 MiB，manifest 和单个 SKILL.md 最多 64 KiB；拒绝绝对 Skill 路径、路径越界与包内符号链接/目录联接。复制过程目前同步执行，较大包会短暂占用事件循环。崩溃残留 `.import-*` 目录不加载。

本地助手挂载变更在已有会话下一次 Turn 前生效。源目录修改不影响已经导入的副本；同 ID 重复导入拒绝覆盖。卸载前同时检查助手定义、会话已应用配置和来源绑定，有引用则返回 `409`。更新包暂时需要解除助手挂载、让相关会话执行一次配置刷新或删除会话、卸载后重导，不提供包覆盖和版本管理。不要手工修改已安装包；这些副本不是内容不可变或隔离的运行环境。

`load_skill` 仅接受当前会话已挂载的 Skill ID。加载前通过 `context.ask()` 请求确认，结果保留 Plugin 来源、内容哈希、Skill 目录和最多 10 个抽样文件。Core 注册十个独立工具：`read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find`、`ls`、`job_output`、`job_kill`。

这十个工具、按绑定出现的 `load_skill` 和 `task` 都是 Pie 原生工具。它们随 Core 代码发行，独立启动就会注册，不经过 Astron 的工具安装器。`PI_TOOLS_DIR` 只加载记忆、邮件、知识库等宿主业务工具；Assistant 的 `toolIds` 再从已注册目录中选择本会话实际可用的工具。

内置工具在创建 Agent 时按 Session 注入 `ToolRuntime`，其中包含 `sessionId`、工作区、确认回调、后台作业表和完成通知；`packages/agent` 与 agent loop 不感知这些服务。`read` 支持文本、目录、图片和 PDF 文本分页，PDF 一次最多 20 页；`edit/write` 返回统一 diff、诊断和 `outputs[{path, artifactRole}]`，供 Astron 生成文件卡片。当前诊断器覆盖 JS、TS、JSON 的语法诊断；尚未迁移 Amio 的多语言 LSP 进程管理器。

`bash/powershell` 支持 `workdir`、秒级 timeout、声明产物和命令分析。工作区外目录、命令参数中的外部路径以及高风险命令通过 `context.ask()` 请求确认。命令超过 `yieldMs`（默认 15 秒，可用 `PI_SHELL_YIELD_MS` 修改）后转为后台作业；`job_output` 只返回上次读取后的新增输出，`job_kill` 终止进程树。默认命令超时为 120 秒，可用 `PI_SHELL_TIMEOUT_MS` 修改。`grep/find` 通过 `rg` 执行并遵守 `.gitignore`；可用 `PI_BASH`、`PI_POWERSHELL`、`PI_RG` 指定可执行文件。服务关闭会取消仍在运行的后台作业；进程崩溃或主动脱离进程树的进程仍不保证清理。

挂载控制模型的 Skill 目录和加载入口，不是系统访问权限隔离。Session 的 `workspacePath` 是审批边界；访问边界外的路径会请求确认，但批准后仍由 Core 系统账户直接访问。当前没有进程沙箱或凭据代理。Skill 中依赖 Astron Engine HTTP 服务、凭据请求、桌面环境的流程仍需相应宿主能力，不因导入成功而自动可运行。

手工验证：在 Web 客户端「插件」中导入仓库的 `examples/plugins/hello-skill` 绝对路径；编辑助手挂载它，并启用 `read` 及当前平台的 `bash` 或 `powershell`；新建真实模型会话，发送“测试本地插件 hello 示例”。预期依次看到 `load_skill`、`read`、命令工具结果。Web 客户端不提供 faux 会话。

无需真实模型的来源验证：启动服务后运行 `node examples/skill-provenance.ts`，会创建“Skill 加载来源演示”faux 会话。两条 Plugin 来源绑定共用 `examples/plugins/hello-skill/skills/hello`，各加载一次。该模式只供 Core 测试和独立脚本使用，不会出现在 Web 客户端的会话列表中；支持精确指令 `加载技能 <绑定ID>` 和 `调用工具 <ID> <JSON对象>`，不会自主规划或选择工具。

2026-09-15 本地兼容检查：Astron `official-diagnostics` 新版包可直接导入并识别 `astron-doctor`。同目录的文档处理与执行编排包仍是没有 schemaVersion 的旧 manifest，不在本版支持范围；没有执行这些官方插件，也没有验证其 Engine 服务依赖。

## 请求和事件流程

```text
PUT /host-runtimes { runtimes: [{ assistantId, assistantRevision, runtime }] }
  → 校验所有 Assistant、Skill、工具和 Subagent 引用
  → SQLite 事务性替换宿主注册表，请求体上限 4 MiB

POST /sessions { assistantId, mode, model?, title? }
  → 本地模式解析 Assistant；宿主模式按 assistantId 读取注册表
  → 保存归属、已应用版本和会话 → 返回 201

POST /sessions/:id/turns { text, assistantId?, systemPrompt? }
  → 检查该会话空闲 → 解析本地最新配置或宿主注册表
  → 配置变化时保留消息并重建 Agent，否则复用 Agent
  → systemPrompt 只覆盖本轮动态系统上下文；Skill 目录仍由稳定 runtime 追加
  → 追加用户消息并持久化 running 状态 → 返回 202
  → Agent.continue() → runAgentLoopContinue()
  → 模型流式输出 / 工具执行 / 下一轮模型响应
  → 等 Agent 空闲 → 保存最终状态 → SSE turn.settled
```

这里先保存用户消息，再用原版 `Agent.continue()` 从已有消息开始循环，确保 `202` 之前输入已落盘。内部 `turn_end` 是一轮模型响应结束；外部 `turn.settled` 才代表整次用户提交已结束。当前每次提交最多 8 轮模型响应；达到上限仍有工具结果待继续时以失败结束。

Web 客户端订阅 `GET /sessions/:id/events`，新连接立即收到全量快照，后续事件也带快照供页面直接替换。Astron adapter 订阅全局 `GET /events`，只接收后续事件并按 `sessionId` 映射为 `CoreEvent`；这个流不传完整 Session 快照。`agent.event` 只带 Astron 使用的 Pi 原生增量及会话标识，`snapshot` 和 `turn.settled` 只带最小 `turn` 状态，避免历史大小放大 token 流和终态事件。`instanceId` 标识服务进程；`revision` 在这个进程的会话内递增。客户端只在相同进程和会话下比较 revision，防止重启后较小的计数使恢复快照被忽略。

Pie 保留 Pi 原生的内容分段：`thinking_start/delta/end` 是思考，`text_start/delta/end` 是正文。Astron adapter 将两组事件分别投影为 `part_appended → part_delta → part_completed`，其中 `partKind` 必须使用 `reasoning` 或 `text`；不能把思考合并进正文。Pie 的 `turn.settled` 是宿主终态来源，adapter 必须发出带 `stopReason` 的 `turn_end`，随后结束本次 prompt。仅收到最后一个文本 delta 不代表 Turn 已结束。

切换会话会关闭旧 SSE 并订阅新会话，不会停止旧任务。浏览器里尚未发送的草稿按会话暂存在内存；刷新会丢失草稿。会话列表每 3 秒查询一次摘要，当前会话完成时立即刷新。原始事件只展示当前页面接收到的最近 120 条，不持久化、不补发。

取消需要明确的 `turnId`。取消接口返回 `202`，最终状态仍以 `turn.settled` 为准。删除和重命名运行中的会话返回 `409`；助手有会话时不允许删除，且至少保留一个助手。

### 多 Core 会话同步

Astron 的产品会话 ID 在切核前后保持不变。每个 Core 继续拥有自己的数据库和原生会话 ID；Astron 在 `coreBindings` 中按 Core 保存原生 ID，并用 `coreBinding` 标记当前活动 Core。Pie 保存导入转储中的 `source.astronSessionId`，后续再次导出时继续使用产品会话 ID。

```text
读取当前 binding 并确认源会话空闲
  → 源 Core 导出 canonical SessionTransfer
  → 激活目标 Core；复用已有目标会话或新建一个
  → 目标 Core 导入并覆盖该原生会话的历史
  → 重新读取目标历史并校验语义一致
  → Astron 原子更新 coreBindings 和活动 coreBinding
```

导入或校验失败时不切换活动绑定；源会话有运行中 Turn 时返回冲突。切回旧 Core 仍执行完整导出、覆盖和校验，因此旧 Core 会得到在新 Core 中新增的对话。迁移只携带 canonical 文本、思考、工具调用和工具结果；Core 私有缓存、运行中 Turn、权限请求和内部元数据不迁移。

## Session Fork

Fork 采用 Pi 上游 `/fork` 的交互语义：用户从历史用户消息中选择一个节点，Core 创建新的独立根 Session，复制该消息之前的历史，并把选中消息文本作为 `selectedText` 返回前端编辑器。原 Session 不移动、不截断。新 Session 复制当时的 Assistant、runtime、模型和工作区快照，保存 `forkedFromSessionId` 作为来源；它不复用 Subagent 的 `parentSessionId`，删除源 Session 不会级联删除 Fork。

当前存储仍是线性 `messages[]`，因此这里只恢复“新会话分叉”，没有引入上游 JSONL 的 entry ID、同文件 `/tree` 导航、标签或分支摘要。`messageIndex` 必须指向空闲根 Session 中的用户消息；压缩摘要不直接复制，新分支保留完整原始前缀，并在达到预算时自行生成摘要。

## Subagent：保持 Pi loop 的最小实现

问题是 Astron 的星小妙需要调用其他 Assistant，但 Pie 不应因此再造一套执行内核。当前解法把 Subagent 保持为普通工具调用：`packages/agent` 不感知父子关系，父 Agent 和子 Agent 都运行原来的 `Agent.continue() → agent loop → tools`。

```text
Astron 当前 Assistant 配置
  → host runtime 注册表中的父 Assistant 只保存 Subagent assistantId 引用
  → Pie 在父 Turn 准入时解析目标 Assistant 当前 runtime
  → 父 Session.runtime.subagents
  → 父 Agent 获得 task AgentTool
  → task(subagent_type, prompt, description, task_id?, background?)
  → 新建持久子 Session，或用 task_id 继续已有子 Session
  → 用目标 Assistant runtime 创建普通 Agent
  → Agent.continue()
  → 最终文本作为 task 结果回到父 loop
```

内部 `SubagentBinding` 包含稳定的调用 ID、名称、说明、目标 `assistantId/assistantRevision`、目标提示词/工具/Skill 配置和可选模型。宿主协议中的 Subagent 只注册 `assistantId` 引用，Pie 从同一注册表补齐目标版本和 runtime，避免每个父 Assistant 重复嵌套目标配置。Astron 决定哪些 Assistant 可调用；Pie 不发现产品 Assistant，也不从本地助手表猜产品权限。独立 Web 模式则通过本地 Assistant 的 `subagentIds` 显式选择目标，由 Core 生成 `assistant-worker-{assistantId}` 绑定。若绑定未指定模型，真实模式继承父会话模型选择。

未传 `task_id` 时创建新子 Session，不复制父消息；传入当前父 Session 拥有、且 Subagent 类型匹配的 `task_id` 时，在原子 Session 消息后追加新用户消息并继续同一个 Agent。子 Session 保存 `parentSessionId/parentToolCallId/subagentType`，完整子事件仍属于子 Session；父 Session 的 task 结果 details 带 `childSessionId/targetAssistantId/subagentType`，后台模式再带 `background/jobId`。默认会话列表隐藏子会话，`includeSubagents=true` 可查询，快照可直接读取。

子 Session 的 HTTP 修改、直接续聊和单独取消被拒绝；父取消通过 task 的 AbortSignal 向下取消。子工具调用 `context.ask()` 时，请求发布到父 Session，用户仍从父会话答复。子 runtime 强制没有 subagents，因此仍只有一层调用。`background=true` 立即返回，子 Session 在后台继续；完成或失败后，Server 向父 Agent 的 follow-up 队列注入带 task ID 的合成消息，父 Agent 正在运行时由当前 loop 消费，已空闲时启动一个新 Turn。后台作业也可由 `job_output/job_kill` 查询或取消。

## 持久化和中断恢复

默认数据目录 `.pie/`，可通过 `PI_DATA_DIR` 指定：

| 文件 | 内容 |
| --- | --- |
| `models.json` | Pi 风格的提供商/模型配置和服务默认选择；可能含明文凭据或环境变量引用 |
| `agent.sqlite` | 助手定义、宿主 runtime 注册表、会话归属和已应用 runtime 快照、完整 Pi 消息、技能记录、最近一次 Turn |
| `plugins/<id>/` | 导入的插件包副本，以 plugin.json 为清单；启动时重新读取 |
| `tools/` | 宿主提供的工具代码，默认从这里加载；可用 PI_TOOLS_DIR / --tools-dir 指定其他目录 |

SQLite 使用 Node 内置 `node:sqlite`，不增加依赖。当前 Node 会输出此内置模块的实验性提示。数据库采用独占连接锁，同目录第二个服务启动失败；锁由进程退出释放。工具和提供商对象不会序列化进数据库。旧助手及会话记录缺少 pluginIds 时按空列表读取；除此之外没有通用跨版本迁移框架，不支持手工改库。

持久化时机是创建/修改/删除、接受用户消息、每个 `message_end` 和整次执行结算。消息保存原版 Pi 数据，包括思考、工具调用/结果和模型元数据，以供恢复上下文；流式 token 的中间片段只在内存中。SQLite 的单条写入是原子的，API 写入成功才返回成功。

技能记录另外在受理和完成时持久化：先保存 running 记录，再读取 Skill；结束后保存状态、时间和结果摘要。`activity.updated` 通过 SSE 推送同一记录 ID 的更新，快照中的 `activities` 提供完整历史；工具结果 `details.activity` 保留同一来源，不从模型返回文本解析归属。Skill 正文的 `contentHash` 是本次加载文本的 SHA-256；超过 64 KiB 拒绝加载。配置与来源快照不冻结文件内容，Skill 文件仍可被外部修改。

服务崩溃后，重启将遗留 `running` 标记为 `failed`。对于已经保存调用、但没有保存结果的工具，补入“执行结果未知”的错误结果；不会重放工具，也不会自动再次调用模型。工具可能已经产生副作用，用户需要核对后显式继续。已经落盘的完整消息保留，未完成的流式片段可能丢失。

未完成的技能记录转为 `unknown` 并保留当时的来源绑定。如果加载结束记录已落盘、原工具输出尚未落盘，保留已知的技能记录，并提示原工具输出未保存。进程崩溃后不保证其子进程已经停止，也不把未收到结果当作执行失败的证据。

会话写入故障后会拒绝继续受理写操作；内存中的历史仍可读。该版本没有任务级事务、工具副作用的恰好一次保证、自动恢复执行、备份 UI 或多用户隔离。

## 与 Astron 的分工及接入进度

2026-09-23 当前范围：Astron 管理产品配置和能力资产，Pie 消费运行配置，记录 Skill 加载及其 Plugin 来源。APA 实际执行溯源暂缓，后续单独设计。原版 loop 不需要插件业务逻辑。插件安装和技能复用已经由 Astron 处理，再向 Pie 导入一份插件，会出现两套文件、挂载关系和卸载规则需要同步的问题。

### Astron 当前已经做了什么

以下路径均相对 Astron 的 `engine/servers/astronverse-agent/src/astronverse/agent/`：

| 代码入口 | 已实现的职责 |
| --- | --- |
| `plugin/manager.py`：`install_plugin_from_directory`、`uninstall_plugin` | 安装、元数据、冲突/复用决策、运行依赖准备入口、卸载及助手引用检查 |
| `plugin/manager.py`：`_materialize_plugin_skills_to_managed_root`、`build_plugin_runtime_index` | 根 Skill 整理到 `.agents/skills`；嵌套 Skill 保留插件目录；按复用关系生成运行索引 |
| `runtime/product_state.py`：`RuntimeConfigInputs` | 把设置、助手、群组和 Skill 元数据作为产品侧配置输入 |
| `adapters/opencode/runtime_config_builder.py` | 把公共目录和选中的插件嵌套目录写入 `skills.paths`，组装模型和角色配置 |
| `adapters/opencode/agent_builder.py`：`build_assistant_skill_permission` | 默认拒绝 Skill，只允许该助手解析出的 Skill ID |
| `adapters/opencode/config_builder.py` | 准备 Core 启动配置、可执行程序路径和宿主环境变量 |
| `core_contract/ports.py` | 提供运行时、会话、Turn、事件及交互接口，没有插件安装或产品助手 CRUD 接口 |

Astron 的 Assistant 是产品资产；其 OpenCode adapter 把助手配置转换为 direct/worker 角色。产品 Session 记录助手归属，并通过 `coreBinding` 关联 Core 的运行会话。Pie 不需要重复拥有这些产品对象的管理权。

### 接入后的职责

| 内容 | Astron / 宿主负责 | Pie Core 负责 |
| --- | --- | --- |
| Plugin / Skill 资产 | 导入、安装、更新、卸载、版本、冲突和复用；维护实际文件 | 使用宿主确定的技能来源绑定，不复制或删除 Astron 的资产 |
| Assistant | 身份、提示词、插件挂载、启停和产品配置存储；启动及配置变化时同步注册表 | 持久化宿主 runtime，以注册版本组装 Agent，执行工具和 Skill 可用范围 |
| Skill 加载 | 决定技能身份、最终来源及助手可用集合 | 建立运行索引，提供 `load_skill`，按需读取正文和资源路径，记录实际加载的来源 |
| Skill 来源 | 提供 Skill 与 Plugin 绑定，定义产品统计口径并汇总 | 记录实际加载的来源、调用 ID 和结果，保留历史绑定快照 |
| 模型 | 提供商设置、模型选择和凭据管理 | 解析下发的调用配置，通过 `packages/ai` 调用模型 |
| 环境与权限 | 工作区、依赖、环境变量、产品权限策略及审批决定 | 按配置执行文件/命令工具；实现权限检查、等待和取消的运行机制 |
| Session / Turn | 产品归属、标题、入口、展示、`coreBinding` 和可调用 Assistant 集合 | 消息上下文、父子 Session、Agent 实例、循环、运行状态、恢复和事件 |
| 配置变更 | 生成权威 runtime 注册表、发起刷新，协调资产文件的更新时间 | 事务性替换注册表；下一 Turn 准入时应用，不中断在途 Turn |

来源绑定、Skill 加载记录、确认型交互和 Turn 边界的配置刷新已在 Pie 实现。Astron adapter 已接入提示词、工具、Skill/Subagent runtime、会话和交互字段。限制 `load_skill` 的可用 ID 不能代替系统文件或命令工具的访问控制。APA、App、RPA 的业务含义和服务仍留在 Astron。通过 `bash/powershell` 执行的命令不自动关联到某个 Skill 或 APA。

Pie adapter 位于 Astron 一侧，负责把产品配置转换为 Pie 接受的运行配置、启动/连接服务、映射会话和转换事件。产品服务继续使用 `core_contract`，不直接消费 Pi 原始事件或依赖 OpenCode 的角色命名和消息格式。

### 共享 Skill 的具体链路

例如插件 A、B 都引用 `pdf`，且 Astron 已明确选择复用同一能力：

```text
Astron 安装 / 复用决策
  → .agents/skills/pdf/SKILL.md（只有一份公共运行文件）
  → 助手挂载 A、B → 保留 A/pdf、B/pdf 两条来源绑定
  → Pie adapter 下发绑定、同一个实际路径、允许加载的 ID
  → Pie 提示词展示可选择的 ID、说明，必要时展示来源名称
  → 模型调用 load_skill({ id: "B/pdf" })
  → 返回正文和实际目录；结构化记录本次经由 B 加载 pdf
  → 后续 read / bash / powershell 独立执行，不自动归因给最近加载的 Skill
```

Pie 通过 `PUT /host-runtimes` 接收宿主运行配置；绑定 ID 的字符串格式不是协议要求。注册表中的 runtime 完整定义提示词、工具和技能配置，不与本地助手挂载隐式合并。Skill 来源可以直接指向 `.agents/skills` 或插件嵌套目录。独立模式由本地插件管理层生成配置；Astron adapter 从产品态组装全部 Skill/Subagent 引用，在启动和产品配置刷新时同步一次。

Pie 不必创建或维护 `.agents/skills`，但应能消费 Astron 已整理的公共目录和插件嵌套目录。没有必要为了接入 Pie 删除 Astron 的公共目录。技能重名是否表示同一个资产，由 Astron 的显式复用关系决定；Pie 不应按同名自动合并、选择覆盖者或发明另一套资产身份规则。

文件复用不等于调用来源合并。若只下发去重后的 `pdf`，A、B 同时可用且本次调用没有选择来源，就不能唯一归因；应记录来源未确定，不能随便选 A，也不能给 A、B 各算一次调用。宿主可以通过明确的用户选择或有来源区分的技能目录确定绑定。调用经由哪个插件与实际文件最初来自哪里是两种信息，应分别保留，不能从公共目录路径倒推调用归属。

### Skill 加载来源记录

来源绑定由宿主生成，标识“通过哪个 Plugin 加载哪个 Skill”。`SkillBinding.id` 是可选择的绑定 ID，name/description 是技能说明，directory 是实际 Skill 目录；source 保存 Plugin 身份和可选 pluginVersion。创建会话时固定配置，调用记录再保存当时的绑定。未提供来源的 Skill 可以省略 source。

Pie 根据模型选择的允许绑定查找来源，技能记录包含独立 id，并关联 `sessionId/turnId/toolCallId`。来源不由模型自由填写，也不靠解析工具返回文本。实现复用 Pi 的工具 `details` 和 `afterToolCall`，错误结果也保留来源；agent loop 源码未改动。

成功加载只证明这次读取了哪条绑定的 SKILL.md，不能证明模型遵循了技能或执行了 APA。后续 `read`、`bash`、`powershell` 独立执行，不继承最近加载的 Skill 来源。APA 执行溯源后续单独设计。

对照当前 Amio OpenCode 的 `packages/opencode/src/tool/skill.ts`，其工具 metadata 只有 name/dir。Pie 在这里增加的是来源绑定及持久化的 Skill 加载记录。

### Pie 下一步开发边界

当前运行输入已支持提示词、内置/外部工具选择和技能绑定；模型仍通过 Pie 模型配置和会话选择接口解析，环境来自服务进程。Pie 已定义已有会话刷新语义：宿主更新注册表，Core 在下一 Turn 执行前按稳定 Assistant ID 应用当前版本。Astron adapter 从产品态组装完整 Skill 与 Subagent 引用，并在 Assistant、群聊、插件或 Skill 配置变化时重新同步；普通 Turn 只传文本和动态系统上下文。TurnMetadata.skill_ids/plugin_contexts 不等于实际使用证据。

当前 Web 客户端的助手、模型和插件管理继续用于独立测试。plugins.ts 已负责将本地挂载转换为 runtime；agent.ts / skills.ts 消费 runtime，不依赖 plugin.json 或插件导入 API。无需为此建立市场服务或共享技能资产库。

配置在下一次 Turn 准入前生效，不中断正在运行的 Turn。宿主仍需协调旧文件的保留/替换；快照不冻结运行文件，插件资产更新闭环尚未实现。本地 Web 的助手、模型和插件管理继续保留，Astron 通过 host runtime 使用同一执行入口。

### Astron 工具文件接入

2026-09-15 核对 Astron 工具安装器、记忆/搜索工具、确认工具入口及 Amio OpenCode 工具注册代码。当前 Astron 的系统工具和 Skill 是两个入口：Skill 提供说明，系统工具提供参数 schema 与执行函数。

当前链路如下，Astron 路径相对 `engine/servers/astronverse-agent/src/astronverse/agent/`：

```text
resources/capability_profile.py：get_enabled_agent_tool_ids()
  → adapters/opencode/config_builder.py：冷启动时准备工具资产
  → adapters/opencode/tools/installer.py：复制选中的 tool_assets/*.ts 到 config_home/tools
  → launcher.py：通过 OPENCODE_CONFIG_DIR 指定配置目录
  → Amio packages/opencode/src/tool/registry.ts：扫描 tool/tools 下的 JS/TS，注册工具定义
  → 模型调用工具 → execute(args, context)
  → 多数工具通过 ASTRON_RPA_ROUTE_BASE_URL / ASTRON_RPA_ROUTE_PORT 调用 Astron local-router
```

例如 `memory-manage` 从执行上下文获取 sessionID，通过 `/agent/memories/entries` 操作 Astron 记忆；返回模型可读的 output，以及用于展示的 metadata。记忆存储和业务校验仍由 Astron 服务负责。`search-knowledge` 还读取 Astron 会话存储来解析云端会话，不能只替换服务地址就认为接入完成。

Pie 的 `packages/agent/src/types.ts` 已定义 `AgentTool`：名称、说明、参数 schema，以及 `execute(toolCallId, params, signal, onUpdate)`。loop 已处理参数校验、执行、部分结果、最终结果和工具错误。现在服务层从宿主指定目录加载工具文件，创建会话时将其转换为原生 AgentTool；不改 loop，也不增加远程工具调用协议。

```text
Astron 提供适配后的工具文件
  → Pie 启动时读取 PI_TOOLS_DIR（默认 PI_DATA_DIR/tools）
  → GET /tools → Web 客户端 / 宿主选择 toolIds
  → 为 Session 调用工具创建函数，注入 sessionId、directory、env、Type
  → 得到 AgentTool → 模型选择工具 → 原版 loop 调用 execute
  → 工具继续调用 Astron HTTP 服务
  → content 交给模型，details 随工具事件及最终消息返回并保存
```

每个 `.ts/.js/.mjs` 文件默认导出一个同步创建函数，返回一个 `AgentTool`；文件名（不含扩展名）就是工具 ID，必须与 tool.name 一致。只扫描目录第一层，跳过 `_` 开头的辅助文件及 `.d.ts`；重复 ID、覆盖内置工具或 `load_skill` 会报错。默认目录不存在时视为没有外部工具；显式指定不存在的目录会阻止启动。

工具代码是宿主提供的可信代码，与 Core 同进程执行。加载模块会执行顶层代码；创建函数只应组装工具，不应发起业务请求或启动后台任务。`Type` 由 Pie 提供，类型导入会被 Node 擦除，示例复制到仓库外仍可运行。其他运行依赖按工具文件位置通过 Node 解析，由宿主准备。加载采用 Node 原生同步模块机制，TS 仅支持可擦除语法，模块及依赖不能有顶层 await。

工具创建函数接收的 `sessionId` 是 Pie 会话 ID；`directory` 是该会话的工作区，宿主可在创建会话时用 `workspacePath` 指定；`env` 是服务创建时的只读快照，不通过 HTTP 返回。每个会话创建独立工具实例，模块级变量仍属于进程共享状态，工具作者不应把会话数据放在模块全局。

工具代码变更需要重启服务进程。数据库仅保存选择的工具 ID 与执行消息，不保存函数或冻结代码；重启后用当前目录恢复工具。被移除的工具若仍被旧会话选中，历史可读，继续执行报错，不静默忽略。助手设置可取消选择已不可用的工具；已有会话仍保留旧配置。

| 接入点 | Astron / 适配层 | Pie 服务层 |
| --- | --- | --- |
| 工具注册 | 提供工具文件和业务执行实现，选择启用集合 | 已实现目录加载、工具目录查询、按会话选择及 ID 校验 |
| 参数 | 当前 OpenCode 工具使用 Zod `args`；适配为 Pie 接受的参数 schema | 继续使用 AgentTool 参数校验，不引入 OpenCode SDK 到 loop |
| 调用上下文 | 负责产品会话与 Core 会话映射、工作区及 Astron 服务地址 | 已注入 Pie sessionId、会话工作区和环境；执行时提供 toolCallId、取消信号和更新回调 |
| 结果与事件 | 将 output 转为 content，metadata 转为 details；向 Astron 转换事件 | 保存结构化结果，通过现有工具事件和会话消息回传 |
| 用户交互 | 凭据、邮件确认工具依赖 `context.ask()` 的等待与答复 | server 提供确认型 `context.ask()`、SSE 请求和 HTTP 答复；表单与权限策略仍由后续 adapter 扩展 |

`examples/tools/memory-manage.ts` 是首个 Astron 工具适配示例，保留 list/add/delete 及 Engine 路由，使用 TypeBox 参数与原生 content/details。工具内连接取消信号，HTTP 请求超时 30 秒。源码测试把示例复制到仓库外的带空格目录，用本地模拟 Astron 服务验证调用、隔离、错误、取消和重启恢复。启动方式和工具示例见 [服务协议](../packages/server/README.md#外部工具文件)。

Astron 侧现已建立 `adapters/pie/tools/tool_assets/` 作为发行来源，当前适配 19 个工具：记忆、三个 IM 工具、Capability 预览/打开/提交、诊断、联网搜索、三个计划任务工具、确认与凭据、邮件、知识检索/表格查询/知识管理和安全 Shell。Capability 工具使用当前的 `open-capability`、`submit-capability` 名称及 `/agent/capability/submissions` 协议。`adapters/pie/tools/installer.py` 在启动前按 capability profile 同步已选工具及共享 `_astron.ts`、`_opencode.ts`：内容相同不重写，更新使用原子文件替换，禁用或退役时只删除已知受管文件，保留其他文件。工具源码随 Astron 版本维护，Pie 同名示例只用于独立开发验证。

独立入口 `python -m astronverse.agent.adapters.pie.launcher` 读取 Astron capability profile，与已适配工具取交集，明确列出未适配项；先同步到指定 runtime_dir/tools，再通过 `PI_TOOLS_DIR` 交给 Pie。`PI_DATA_DIR` 为 runtime_dir/data，Engine 地址由当前 route_port 注入。传递给子进程的是参数列表，可运行源码 Node 命令或打包后的 Pie。开发时也可以直接把 PI_TOOLS_DIR 指向 Astron 的源码资产目录。

启动器由 Astron 拥有，不在 Pie 内增加宿主业务逻辑。一个 runtime 由一个启动方管理，先关闭旧 Core 再同步和启动；目前没有工具热更新和多启动方协调。官方 `pie` provider 已注册到 Cowork Core registry，并在目标会话切换到 Pie 时懒激活；事件中心会为新激活的 Core 建立订阅。adapter 的 `PieLauncher` 在生命周期线程中负责动态端口、工具同步、进程启动、`/health` 探活、日志、停止、重启和限次异常恢复。历史 `adapters/pi` 源码已经删除。Astron 中的操作说明和验证入口为 astronverse-agent/docs/pie-tools.md。

Pie 用 Node Single Executable Application 生成 `pie-agent(.exe)`。Cowork 发行资源路径为 `resources/binaries/<platform>/<arch>/pie-agent(.exe)`；Electron 和原生 launcher 启动时将它同步到用户目录的 `pie-agent/`。Astron 按 `ASTRON_PIE_RUNTIME_EXECUTABLE`、用户目录副本、发行资源的顺序解析可执行文件。每个用户的运行数据位于 Agent runtime 根目录下的 `cores/pie/`，其中 `data/agent.sqlite`、`data/models.json`、`tools/` 和 `state/*.log` 分开保存。受管进程启动前把 Astron 的内置/OpenAI Compatible/Anthropic Compatible 提供商投影为 Pie 原生 `models.json`，保留启用模型、默认选择、模态、上下文和输出限制；Astron 的环境变量配置随进程注入。若显式配置 `ASTRON_PIE_CORE_URL` 或 `PIE_CORE_URL`，adapter 进入外部连接模式，不管理该进程或模型文件。

跨仓库定向测试从 Astron 资产同步后启动真实 Pie 子进程，用假模型和本地 Router 验证全部 19 个适配文件的加载与 TypeScript 类型，并覆盖记忆、联网搜索、计划任务、Capability 打开/提交、邮件确认、凭据确认、邮件读取、知识检索、表格查询、知识管理、安全 Shell、重启恢复与禁用工具。真实 Astron Router 已用 `astron-web-search` 完成联网搜索；知识库工具仍依赖产品会话到云端会话的映射，尚未完成真实产品链路验证。确认型 context.ask 已在 Pie server 闭环，复杂表单和 APA 执行溯源仍暂缓。

## 代码入口和验证

| 文件 | 修改场景 |
| --- | --- |
| `packages/server/src/protocol.ts` | HTTP/SSE 类型和公开概念 |
| `packages/server/src/server.ts` | 助手/父子会话 API、task 派发、并发准入、事件发布和结算 |
| `packages/server/src/store.ts` | SQLite、消息落盘与中断恢复 |
| `packages/server/src/agent.ts` | 助手配置转换、注册工具、真实模型调用和测试 provider |
| `packages/server/src/compaction.ts` | 上下文预算、切分点、摘要生成输入和压缩后模型上下文 |
| `packages/server/src/plugins.ts` | Astron manifest 的 Skill 索引、本地导入与卸载 |
| `packages/server/src/skills.ts` | 运行配置校验、load_skill、来源与加载结果 |
| `packages/server/src/tools.ts`、`tools/` | 十个内置工具的 Core 适配、文件操作、搜索、系统命令和后台作业管理 |
| `packages/server/src/external-tools.ts` | 工具文件加载、ToolContext、工具 ID 和定义校验 |
| `examples/tools/memory-manage.ts` | Astron 记忆工具适配示例，可复制到外部目录 |
| `packages/server/src/models/` | 上游模型配置抽取和提供商管理 |
| `apps/web/client/main.tsx` | 助手选择、会话列表/切换、SSE、聊天和会话详情 |
| `apps/web/client/assistant-settings.tsx` | 助手配置表单 |
| `packages/agent/src/agent.ts`、`agent-loop.ts` | 原版执行内核，当前保持 `b2602be` 基线 |

运行 `npm run check` 做格式、类型和模型目录检查。定向测试 `npm run test:server` 覆盖助手配置、工具过滤、会话隔离、重启、删除、独占存储、崩溃恢复、HTTP/SSE、上下文压缩和模型配置；也覆盖十个内置工具的注册、文件读写改查、搜索、Plugin 根/嵌套 Skill、共享绑定来源、脚本执行，以及 Shell 失败、限额、取消、后台执行和超时。`external-tools.test.ts` 覆盖外部工具文件加载、目录查询、按会话启用、模拟 Astron HTTP 调用、参数错误、业务拒绝、取消和重启恢复。只用假模型和本地 HTTP fixture。只有修改内核时再运行相关 `npm run test:core`。

自动压缩位于服务层，不修改 `agent-loop.ts`。真实模型每次调用前，`transformContext` 根据最后一次有效模型 usage 加尾部消息估算 token；超过模型窗口减去保留预算时，用同一模型生成结构化摘要，并把“摘要 + 最近消息”作为本次模型上下文。切分点不会落在 `toolResult`，后续压缩会把新历史合并进旧摘要。摘要记录随会话持久化，完整消息数组保持不变，因此页面和恢复仍能看到原始历史。摘要请求失败时回退到原上下文。

当前仍限制 32 个助手和 32 个会话（含子会话），完整历史载入内存；每 Session SSE 推全量快照，全局 `/events` 只推增量事件，适合开发验证。长历史分页和持久 Turn 列表仍是后续能力。
