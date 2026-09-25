# Pie Core 服务 v1

用 Node 独立运行的本地服务，不依赖 React、assistant-ui 或 Vite。包内 `src/protocol.ts` 是框架无关的数据类型；原版 `packages/agent` 仍只负责执行内核。

主要架构和开发边界统一维护在 [Agent 开发文档](../../docs/agent-development.md)。

从仓库根目录执行 `npm run serve -- --port 4318`。仅监听 `127.0.0.1`；`--port 0` 自动分配端口。启动后 stdout 输出 `{"type":"ready","url":"http://127.0.0.1:实际端口"}`。

## HTTP

请求体为 JSON 对象，必须带 `Content-Type: application/json`。普通请求最多 64 KiB；宿主 runtime 注册表最多 4 MiB；会话导入最多 32 MiB。设置 `PI_SERVER_TOKEN` 时，所有请求（含 health 和 SSE）需要 `Authorization: Bearer <token>`。Web 客户端通过同源 Vite 代理访问；Core 默认只允许 `http://127.0.0.1:5174` Origin，可用 `PI_WEB_ORIGIN` 覆盖。

| 方法和路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /health` | 无 | 健康状态、protocolVersion、coreId、`persistence: sqlite`、真实模型配置是否就绪（不含凭据） |
| `GET /tools` | 无 | `{ tools: [{ id, label }] }`，已注册的内置和外部工具；外部工具在会话创建前以 ID 作为 label |
| `GET /assistants` | 无 | `{ assistants: [...] }`，助手定义列表 |
| `POST /assistants` | `{ name, systemPrompt, toolIds, pluginIds?, subagentIds? }` | `201` + 助手定义，ID 由服务生成；省略列表字段时为空 |
| `PUT /assistants/:id` | `{ name, systemPrompt, toolIds, pluginIds?, subagentIds? }` | 完整更新定义；已有本地会话在下一次 Turn 前应用；助手不能调用自己 |
| `GET /plugins` | 无 | `{ plugins: [...] }`，插件信息及已启用的 Skill ID/name/description/path |
| `POST /plugins/import` | `{ path: "本地插件目录" }` | `201` + 插件信息；复制并校验 schemaVersion 1 包，不自动安装依赖 |
| `DELETE /plugins/:id` | 无 | 卸载；存在助手或会话引用时返回 409 |
| `DELETE /assistants/:id` | 无 | 删除无会话的助手；至少保留一个 |
| `GET /sessions?assistantId=...&includeSubagents=true` | 查询参数可省略 | `{ sessions: [...] }`，默认只列根会话；includeSubagents=true 时包含子会话 |
| `GET /models` | 无 | 内置和自定义模型目录、默认选择；不含密钥和 headers |
| `GET /providers` | 无 | 已配置的提供商名称、协议、地址、模型列表、密钥配置状态和默认选择 |
| `PUT /providers/config` | `{ id, name, api, baseUrl, apiKey?, models, defaultModel? }` | 按提供商保存；models 为完整列表，返回提供商目录 |
| `POST /providers/discover` | `{ id, name, api, baseUrl, apiKey? }` | 只读取指定端点的模型目录，返回 `{ models: [{ id }] }`，不保存配置 |
| `PUT /models/config` | `{ provider, id, model?, apiKey? }` | 合并配置并持久化，将该模型设为默认，返回模型目录 |
| `POST /models/reload` | `{}` | 重新读取模型配置文件；失败时保留当前有效配置 |
| `PUT /host-runtimes` | `{ runtimes: [{ assistantId, assistantRevision, runtime }] }` | 事务性替换宿主 runtime 注册表并持久化；最多 256 个 Assistant，runtime 可引用同一批次中的 Subagent Assistant |
| `POST /sessions` | `{ assistantId?, title?, mode?, model?: { provider, id } }` | `201` + 会话快照；assistantId 命中宿主注册表时创建宿主会话，否则解析本地助手；mode 默认 faux |
| `PATCH /sessions/:id` | `{ title }` | 重命名空闲会话，返回快照 |
| `GET /sessions/:id` | 无 | 会话快照，含全部已完成消息、当前部分消息、最近一次 turn |
| `GET /events` | 无 | 宿主使用的全局 SSE，只推送连接后的所有会话事件，不发送初始快照 |
| `GET /sessions/:id/events` | 无 | SSE，第一条是当前快照，然后推送后续事件 |
| `GET /sessions/:id/export` | 无 | 导出 canonical `SessionTransfer`；运行中的会话返回 409 |
| `PUT /sessions/:id/import` | `SessionTransfer` | 用转储覆盖空闲会话历史并保留产品会话 ID；失败时回滚原状态 |
| `POST /sessions/:id/fork` | `{ messageIndex, title? }` | 按上游 `/fork` 语义从指定用户消息之前创建独立根会话，返回 `{ session, selectedText }`；原会话不变 |
| `POST /sessions/:id/turns` | `{ text, assistantId?, systemPrompt? }` | `202` + `{ sessionId, turnId }`；宿主会话在准入时读取已注册的最新 runtime，systemPrompt 是本轮动态完整系统上下文 |
| `POST /sessions/:id/cancel` | `{ "turnId": "要取消的 turn" }` | `202`，请求取消；以最终 `turn.settled` 为准 |
| `POST /sessions/:id/interactions/:interactionId` | `{ "approved": true/false }` | `202`，答复当前工具交互；以 SSE 的 `interaction.resolved` 为准 |
| `DELETE /sessions/:id` | 无 | 删除空闲会话并关闭对应事件连接 |

`400` 为无效输入/真实模型不可用，`401` 为认证失败，`403` 为 Host/Origin 不允许，`404` 为助手/会话/接口不存在，`409` 为会话忙、turn 不匹配、删除约束或助手/会话达到各自 32 的限制，`413` 为请求过大，`415` 为 Content-Type 不支持，`503` 为服务关闭中或存储故障后拒绝写入。错误响应为 `{ "error": "说明" }`。

助手名称和会话标题最多 100 个字符且不允许空白；systemPrompt 为最多 16000 字符的字符串，可为空。toolIds 从 `GET /tools` 返回的工具中选择，最多 128 项、无重复，可为空；内置工具为 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`、`job_output`、`job_kill`。默认助手的 toolIds 为空，默认启用集合后续再定。pluginIds 为已安装插件 ID 的无重复列表。有 Skill 绑定时自动提供 `load_skill`。subagentIds 为其他本地助手 ID 的无重复列表；被引用的助手不能删除。

这些内置工具属于 Pie Core：代码随 Core 发行，独立启动时直接注册，不依赖 `PI_TOOLS_DIR` 或 Astron 同步。注册只表示工具存在于目录中；每个 Assistant 仍通过 `toolIds` 控制可见和可执行范围。命令工具只暴露 `bash`，Windows 内部使用 PowerShell；启用 `bash` 或 `task` 时自动向 Agent 加入 `job_output/job_kill`。`load_skill` 和 `task` 也由 Pie 提供，但分别只在当前 runtime 有 Skill 或 Subagent 绑定时加入 Agent。Astron 的业务工具继续通过 `PI_TOOLS_DIR` 加载。

会话摘要和快照包含 `assistantId`、已应用的 `assistantRevision`、`runtimeSource`（`local` 或 `host`）及完整 `runtime`。本地会话还返回 `assistant`，宿主会话不伪造本地 Assistant 对象，因此该字段可以省略。Fork 会话额外保存 `forkedFromSessionId`；它与 Subagent 使用的 `parentSessionId` 无关，删除源会话不会删除 Fork。宿主启动后通过 `PUT /host-runtimes` 注册全部 Assistant，配置变化时重新提交权威快照；Session 和 Turn 不接受内联 runtime。配置变化发生在 Turn 准入前：已有消息保留，空闲 Agent 按最新注册版本重建；正在运行的 Turn 不被切换，下一次提交才应用新配置。

宿主 runtime 可带 `subagents`。每项只包含模型可见的 `id/name/description`、目标 `assistantId` 和可选 `model`；目标 runtime 和版本从同一注册表解析，不在父 runtime 中重复嵌套。存在绑定时，父 Agent 自动获得 `task({ description, prompt, subagent_type, task_id?, background? })` 工具；`task` 不属于可配置 toolIds，也不出现在 `GET /tools`。省略 `task_id` 时创建持久子会话；传入当前父会话已有的子 Session ID 时继续原任务。`background=true` 会立即返回 job ID，完成后向父 Agent 注入通知；`job_output` 可增量读取，`job_kill` 可停止任务。子会话用目标提示词、工具和 Skill 运行同一个 Agent loop，不继承父历史或目标 Assistant 的其他会话历史，不再拥有 task，且 HTTP 侧只读。父会话取消会取消前台子会话；子工具的确认请求通过父会话交互接口答复。删除父会话会一并删除子会话。

独立 Web 模式在 Assistant 设置中选择“可调用助手”，Core 将 subagentIds 转为内部 runtime 结构，调用 ID 为 `assistant-worker-{assistantId}`。目标 Assistant 修改后，已有父会话下一次提交会解析其最新提示词、工具和 Skill。该入口用于独立开发和测试；接入 Astron 后由宿主注册引用关系。

## 外部工具文件

宿主把适配后的工具文件放到 `PI_DATA_DIR/tools`（默认 `.pie/tools`），或启动时指定目录：

```sh
npm run serve -- --tools-dir E:/Projects/pie/examples/tools
```

也可设置 `PI_TOOLS_DIR`。目录加载与 Skill 插件导入分别工作，无需 plugin.json。每个工具文件默认导出一个同步函数，接收 ToolContext 并返回原生 AgentTool。文件名是工具 ID，只允许 1–64 个字母、数字、下划线或连字符，必须等于返回对象的 name。支持 `.ts/.js/.mjs`，不递归扫描，跳过 `_` 前缀和 `.d.ts`。同名文件、内置 ID、load_skill 或 task 冲突会报错。

例如保存为 `hello.ts`：

```ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "@pie/server/tools";

export default function createTool({ Type, sessionId }: ToolContext) {
  const parameters = Type.Object({ name: Type.String() });
  return {
    name: "hello",
    label: "问候",
    description: "Greet someone in the current session.",
    parameters,
    async execute(_callId, { name }) {
      return {
        content: [{ type: "text", text: `Hello ${name}` }],
        details: { sessionId },
      };
    },
  } satisfies AgentTool<typeof parameters, { sessionId: string }>;
}
```

开发时通过 Pie workspace 或 TypeScript paths 解析上面的 SDK 类型；Node 执行时会擦除类型导入。Type 构建器由 Pie 提供，因此此示例的运行不需要在工具目录安装 Pi/TypeBox。其他运行依赖由宿主准备，按 Node 相对于工具文件的规则解析。

上下文包含 Pie `sessionId`、会话工作区 `directory`、只读 `env` 快照、`Type` 和 `ask`。每个会话创建一份工具实例；execute 沿用原生的 toolCallId、参数、AbortSignal、onUpdate，返回 content/details，出错时抛出异常。`ask({ type: "confirmation", title, message, metadata? }, signal?)` 会暂停当前工具，向 SSE 推送 `interaction.requested`，等待 `POST /sessions/:id/interactions/:interactionId` 的批准或拒绝；拒绝、取消和服务关闭都会让 Promise 以错误结束。宿主 runtime 可用 `permissions` 配置权限 ID 的 `allow/ask` 决策，精确项优先于 `*`；没有 `metadata.permission` 的显式确认始终交给用户。Pie 保存最终工具消息及 details，并通过 tool_execution_update/end 事件回传更新。全局 `/events` 会同时把 details 提升到工具结果顶层，方便 Astron 直接读取 `outputs`、diff 和 diagnostics。

Web 客户端的助手设置从 `GET /tools` 读取目录，勾选后新建真实模型会话即可使用；HTTP 也可通过 runtime.toolIds 选择。Web 客户端不创建或展示 faux 会话。faux 模式只保留给 Core 自动化测试和独立脚本，支持精确指令 `调用工具 <ID> <JSON对象>`；未启用的工具返回工具错误。加载不等于启用。

`examples/tools/memory-manage.ts` 适配 Astron 的 list/add/delete 记忆工具；它读取宿主注入的 ASTRON_RPA_ROUTE_BASE_URL 或 ASTRON_RPA_ROUTE_PORT，不硬编码端口。测试使用模拟服务；正式发行工具由 Astron adapter 管理。调用示例：`调用工具 memory-manage {"action":"list"}`。

这些文件是与 Core 同进程执行的可信宿主代码；模块顶层会在启动加载时执行，创建函数只应组装工具，业务请求放在 execute 内。模块及依赖不能使用顶层 await，TS 仅支持 Node 可擦除语法。变更文件需要重启整个服务进程；会话只保存工具 ID 和历史，不冻结工具代码。重启时工具被移除，相关会话历史可读，继续执行会明确报错。

Astron 已在自己的 `astronverse-agent/adapters/pie/` 实现工具发行目录、进程管理器和 Core adapter：首次使用时懒启动 Pie，启动前同步其维护的工具并注入 Engine 端口，随后负责探活、停止、重启和异常恢复。当前已适配 19 个工具；Cowork 已注册 `pie` provider，并支持会话、Turn、交互、事件和跨 Core 历史同步。具体分工见 [Agent 开发文档](../../docs/agent-development.md#astron-工具文件接入)。

## 技能绑定与加载记录

宿主先注册 runtime，再用 assistantId 创建会话，无需导入 plugin.json 或复制技能文件。以下为 `PUT /host-runtimes` 的 Windows 示例，路径需替换成真实目录；name/description 由宿主提供，Skill 正文直到 load_skill 时才读取：

```json
{
  "runtimes": [{
    "assistantId": "astron-assistant-id",
    "assistantRevision": "42",
    "runtime": {
      "systemPrompt": "按需加载技能。",
      "toolIds": [],
      "subagents": [],
      "skills": [{
        "id": "plugin-b/hello",
        "name": "hello",
        "description": "通过 plugin-b 加载 hello",
        "directory": "E:/Projects/pie/examples/plugins/hello-skill/skills/hello",
        "source": {
          "pluginId": "plugin-b",
          "pluginName": "Plugin B",
          "pluginVersion": "1"
        }
      }]
    }
  }]
}
```

注册成功后用 `POST /sessions { "assistantId": "astron-assistant-id", "mode": "faux" }` 创建会话。runtime 包含完整 systemPrompt/toolIds/skills 及可省略的 subagents；最多 128 个 Skill 绑定和 32 个 Subagent 绑定，各自 ID 必须唯一。多个 Skill 绑定可以共用同一个 directory。directory 和可选 resourceRoot 必须是绝对路径。source 可省略，表示没有指定 Plugin 来源；pluginVersion 可省略。本地插件导入会自动生成 Plugin 来源字段。

`load_skill({id})` 加载已允许的绑定，记录 source 和实际正文的 contentHash；超过 64 KiB 拒绝加载。初始模型目录只有绑定 ID、说明和来源名称，不含路径或正文。未挂载的 ID 返回工具错误，不伪造来源。

`activities` 每项包含 id、sessionId、turnId、toolCallId、kind、binding 快照、status 和时间。kind 为 skill_load；status 为 running/succeeded/failed/cancelled/unknown。succeeded 表示 Skill 文件加载成功。绑定快照冻结来源配置，不冻结文件内容。普通 `read`、`bash` 等不产生 Plugin 使用记录，不继承“最近加载的技能”。APA 实际执行溯源后续单独设计。

受理和完成时记录均落盘；SSE 的 activity.updated 携带完整 activity，工具结果 details.activity 携带同一技能记录（sessionId/turnId 位于外层 SSE 和 activities）。刷新/重启通过 activities 恢复历史。崩溃遗留 running 改为 unknown，保留来源且不重跑。未改动原版 loop，使用工具 details 和 afterToolCall 保留成功/错误结果的来源。

本地演示：服务运行后执行 `node examples/skill-provenance.ts`，创建假模型会话并验证共享文件的两条来源绑定各加载一次。可用 PI_SERVER_URL / PI_SERVER_TOKEN 指定服务和认证。Web 客户端的会话详情可查看最近 Skill 活动及可用技能。假模型支持 `加载技能 <绑定ID>`；不调用真实模型。

同会话只接受一个活动 turn；不同会话相互独立。取消必须匹配最近的 turnId，避免延迟请求误取消下一次执行。HTTP 连接关闭、前端刷新和 SSE 断线不会取消模型调用；需要显式发送 cancel。

## SSE

每条 `data:` 是一个 JSON 包：

```json
{
  "type": "agent.event",
  "sessionId": "...",
  "turnId": "...",
  "event": { "type": "tool_execution_start", "toolCallId": "...", "toolName": "ls", "args": { "path": "." } },
  "snapshot": { "id": "...", "mode": "faux", "model": "faux-1", "revision": 17, "messages": [], "turn": { "id": "...", "status": "running" } }
}
```

- `snapshot`：新连接/重连时发送当前状态。恢复消息和运行状态，不回放断线期间的原始事件。
- `agent.event`：原版 Agent 事件，携带 session/turn 标识；不要把内部 `turn_end`（一轮模型响应）当成用户提交完成。
- `activity.updated`：携带持久技能记录 activity，同一个 id 从 running 更新至最终状态；snapshot.activities 保存历史。
- `compaction.updated`：模型上下文达到预算后生成新摘要；snapshot.compaction 保存摘要边界、压缩次数和压缩前后的估算 token 数。
- `turn.settled`：先持久化输入，再等待 `agent.continue()` 完成、Agent 空闲后发送。状态为 `completed`、`cancelled` 或 `failed`，失败原因在 `snapshot.turn.error`。

`revision` 在服务进程的单个会话内递增；客户端在相同 `snapshot.instanceId` 下忽略旧快照，服务重启后接受新的进程快照。每 15 秒发送 SSE 注释心跳。慢客户端的待发送缓冲超过 1 MiB 时断开，客户端重连获取新快照。

## 实现边界

这是便于二次开发的首版服务。Astron adapter 已映射当前所需的 Core contract 子集；未声明的能力仍应明确失败。

- 助手、宿主 runtime 注册表、完整会话消息和上下文摘要保存在 `PI_DATA_DIR/agent.sqlite`（默认 `.pie/`），插件包在 `PI_DATA_DIR/plugins/<id>`。支持按助手挂载 Plugin、按需加载 Skill、自动上下文压缩、确认型工具交互和前台单层 Subagent；不实现 MCP、后台 Subagent 或递归派发。
- Plugin 解释根 skills、apps/apa 的嵌套 skills、enabled/path 及来源身份；本地管理层转换为 runtime，Agent 组装与技能工具不解析插件清单。ZIP 请先解压；不自动安装环境，不执行 MCP/RPA，不处理市场或云端同步。系统工具没有沙箱，`read/edit/write` 可访问宿主文件，`bash` 使用系统账户执行命令，`grep/find` 需要 `rg`。可用 `PI_SHELL`（或平台默认的 `PI_BASH`/`PI_POWERSHELL`）、`PI_BASH_TIMEOUT_MS`、`PI_BASH_YIELD_MS` 和 `PI_RG` 配置可执行文件与超时。详细限制及示例见 [Agent 开发文档](../../docs/agent-development.md#plugin-与-skill)。
- 事件的 `event` 字段保留 Pi 原始格式。Astron adapter 将其转换为 `CoreEvent`；其他宿主也应在 adapter 边界转换，不要将 Pi 原始结构传入产品服务。
- 自动压缩只改变送给模型的上下文：达到模型上下文窗口减去保留预算后，Core 用同一模型生成结构化摘要，保留最近消息，并在后续压缩中合并旧摘要。完整历史仍用于存储和页面展示。摘要失败时本轮继续使用压缩前上下文，不删除消息。当前 SSE 仍推送完整快照；长历史还需要增量事件和分页。
- 最多 32 个助手、32 个会话（含子会话）；全量加载到内存。页面保存 session ID 于 sessionStorage；服务重启后恢复历史，执行按需恢复。独占 SQLite 锁阻止同目录启动第二个服务。不要用此进程承载不同用户的生产会话。
- 模型配置为进程共享，Agent 保留创建时解析的模型调用配置。Assistant/runtime 版本变化或服务重启会重建 Agent，并用会话保存的 provider/model 选择重新解析当前端点和凭据；模型不可用时历史仍可读，提交报错。目录和 health 表示本地配置状态，不代表远端凭据有效；创建会话和保存配置均不调用模型。
- 输入在返回 `202` 前落盘；完整消息在 message_end 落盘，流式片段不逐 token 保存。崩溃遗留的 running 标记为 failed，未匹配工具调用补入结果未知的错误，不自动重放；不保证工具副作用恰好一次。

验证：根目录 `npm run test:server`，包含假模型测试和本地 OpenAI 兼容模拟端点上的真实 SDK + 工具循环、配置重载/重启/校验/密钥不回显测试，不调用付费服务。

## 模型配置

默认文件为工作目录下 `.pie/models.json`，可用 `PI_DATA_DIR` 改变目录。不要指向其他 Pi 进程正在使用的配置目录。保存使用临时文件 + 原子替换；发现外部修改时拒绝覆盖，需先 reload。文件保存采用单服务进程所有权，不提供跨进程锁。

```json
{
  "providers": {
    "custom": {
      "api": "openai-completions",
      "baseUrl": "https://your-endpoint.example/v1",
      "apiKey": "$MY_MODEL_KEY",
      "models": [{ "id": "my-model", "contextWindow": 128000, "maxTokens": 8192 }]
    }
  },
  "defaultModel": { "provider": "custom", "id": "my-model" }
}
```

`providers` 使用 Pi 上游结构，支持 `//` 注释、尾逗号、`models`、`modelOverrides`、`compat` 和 headers。`defaultModel` 是此服务增加的选择字段，上游解析器会忽略它。不存在该字段时使用 `PI_PROVIDER` / `PI_MODEL`，否则需通过设置选择默认模型或创建会话时显式指定。

Web 客户端使用提供商配置接口 `PUT /providers/config`：

```json
{
  "id": "custom",
  "name": "我的模型服务",
  "api": "openai-completions",
  "baseUrl": "https://your-endpoint.example/v1",
  "apiKey": "$MY_MODEL_KEY",
  "models": [{ "id": "model-a" }, { "id": "model-b", "maxTokens": 8192 }],
  "defaultModel": "model-a"
}
```

一个提供商共用协议、Base URL 和凭据。`models` 是本次保存的完整列表（1–2000 个，不允许重复 ID，仍受 HTTP 64 KiB 限制）；移除的自定义模型不再供新会话使用。保留模型原有的 compat、headers、cost 等高级配置，并应用显式修改。内置提供商原始目录仍由 Pi 保留，移除本地定义不等于禁用内置模型。提供商 ID 为稳定标识，界面编辑时只读。

`apiKey` 省略或空字符串保留旧值。`defaultModel` 指定此提供商下的新会话默认模型；省略时保留当前默认，若原默认被移除则选择列表第一项。`POST /sessions` 的 `model` 可独立选择模型，无需修改全局默认。

「获取」支持 OpenAI Compatible / Responses、Anthropic Messages 和 Google Gemini：分别读取 Base URL 下 `/models`、`/v1/models`、`/v1beta/models`（已有版本后缀时不重复）。OpenAI Base URL 通常应包含 `/v1`，Anthropic 使用 `https://api.anthropic.com`，Google 使用 `https://generativelanguage.googleapis.com/v1beta`。Anthropic / Google 处理分页，Google 过滤明确不支持 `generateContent` 的模型。参照 [Anthropic Models API](https://platform.claude.com/docs/en/api/models/list) 和 [Google Models API](https://ai.google.dev/api/models)。

获取结果先合并到前端待保存列表，去重且保留已有条目；失败不改变文件。获取总超时 15 秒、每页最多 2 MiB、最多 10 页 / 2000 个模型；不跟随重定向，不回显上游错误正文。仅在端点未变时复用服务端已存密钥和 headers，改地址后需重新输入密钥才能获取。获取目录成功不保证该模型能聊天或调用工具。

单模型增量配置接口仍可直接使用：

```json
{
  "provider": "custom",
  "id": "my-model",
  "apiKey": "$MY_MODEL_KEY",
  "model": {
    "api": "openai-completions",
    "baseUrl": "https://your-endpoint.example/v1",
    "contextWindow": 128000,
    "maxTokens": 8192
  }
}
```

把以上对象发送给 `PUT /models/config`。`model` 是上游模型定义的增量字段，省略则仅选择模型或修改凭据；`apiKey` 省略或空字符串保留旧值。同 Provider 的模型共享 API key。要删除密钥或 Provider，编辑文件再 reload。配置查询只返回允许展示的字段；`keyConfigured` 仅表示文件中保存了密钥配置，不检查环境凭据。SDK 报错会通过已有 turn 事件返回。

API key 和 headers 支持 `$VAR` / `${VAR}`，`$$` 表示字面量 `$`，`$!` 表示字面量 `!`。尚未恢复 OAuth / auth.json / 扩展注册 / 上游后台目录刷新机制；`!command` 和 `oauth` 配置明确拒绝。环境变量在服务启动时取快照。无鉴权本地兼容端点可配置占位 key `local`。自定义 Base URL 限 HTTP(S)，不要把凭据放进 URL。

`src/models/model-config.ts` 的 schema、`provider-composer.ts` 的模型/compat 合成、`resolve-config-value.ts` 的模板解析、`json.ts` 来自 Pi `b2602be` 的 coding-agent，并按上述范围抽取；服务文件存储、HTTP API 和 UI 为本项目实现。原版 Agent loop 与 pi-ai 源码未改动。
