# Pie

用于二次开发的 Pi 执行内核。保留原版 `Agent`、agent loop 和 `pi-ai`，通过 SDK、嵌入接口和本地 HTTP/SSE 接入宿主，不附带 Web UI。

主要架构、Assistant / Session / Agent 的关系、数据流和开发边界见 [Agent 开发文档](docs/agent-development.md)，后续随实现同步维护。

```text
你的应用
   ↓ prompt / steer / followUp / abort
Agent                         内存状态、事件、输入队列
   ↓
agent loop                    模型响应 → 校验并执行工具 → 下一轮
   ↓
pi-ai                         provider、鉴权、流式响应、模型信息
```

## 目录

| 路径 | 职责 |
| --- | --- |
| `packages/agent/src/agent.ts` | 状态、事件订阅、取消、steer 和 follow-up |
| `packages/agent/src/agent-loop.ts` | 模型与工具之间的循环、工具参数校验、串行/并行执行、错误回传 |
| `packages/agent/src/types.ts` | Agent、工具及事件类型 |
| `packages/ai` | 原版模型调用层，包括各 provider、流式文本/思考/工具调用和鉴权能力 |
| `packages/mcp` | 独立 MCP 协议客户端：stdio、Streamable HTTP、OAuth；产品适配见 [MCP 接入](docs/mcp-integration.md) |
| `packages/telemetry` | `pi-ai` 使用的观测接口及实现，不自动接入外部平台 |
| `examples/basic.ts` | 用假模型验证真实 Agent、工具执行和流式输出，无需 API key |
| `packages/runtime` | 共享会话运行时与能力契约：Turn、消息树、压缩、Subagent 和事件 |
| `packages/local` | SQLite、本机工具、文件配置、Skill / MCP 和本地助手管理 |
| `packages/server` | 薄本地宿主：装配 Local，映射 HTTP / SSE，保留 CLI / Sidecar 入口 |

Agent 内部保留输入队列和上下文处理钩子；助手、会话持久化、自动上下文压缩和 Plugin / Skill 加载由服务层实现，权限和扩展待规划。没有恢复原版 Harness、CLI、TUI、client/server 或 Chord。

## 独立 HTTP 服务

在仓库根目录启动本地宿主，默认监听 `127.0.0.1:4318`：

```sh
npm run serve
```

通过 [HTTP/SSE 协议](packages/server/README.md) 管理配置、会话和执行，或直接使用 [Runtime 嵌入接口](docs/runtime-embedding.md)。验收使用 SDK、HTTP/SSE 和本地 fixture；执行状态及操作可用性由宿主消费共享契约。

## 功能与配置

默认助手不启用工具。通过助手接口配置 `toolIds`，或通过 `PUT /host-runtimes` 注册宿主 runtime，再创建会话。会话支持重命名、分叉、分支切换、删除和重启恢复；停止执行使用显式取消接口，关闭 SSE 不会停止任务。

真实模型通过 `PUT /providers/config` 配置提供商、端点、凭据和模型列表，创建会话时可指定模型。`POST /providers/discover` 只读取远端目录，结果需检查后保存；保存本身不请求模型，也不验证远端凭据。

配置保存在 `.pie/models.json`（Git 已忽略），重启仍保留；`PI_DATA_DIR` 可更换目录。复用了 Pi 上游 `models.json` 的 schema、模型覆盖合成和环境变量解析；支持自定义模型、`modelOverrides`、headers、compat。详见 [配置接口与格式](packages/server/README.md#模型配置)。API key 写入服务端文件，不在配置查询中回显；文件是明文，亦可填写 `$ENV_VAR` 引用环境变量。当前未接入上游 OAuth 登录、`auth.json` 或 `!shell-command` 取密钥。

也可在根目录 `.env`（Git 已忽略）中设置默认模型和凭据：

```dotenv
PI_PROVIDER=anthropic
PI_MODEL=claude-sonnet-4-6
ANTHROPIC_API_KEY=填入自己的密钥
```

`PI_PROVIDER` 可指定内置 Provider，模型 ID 需存在于目录；相应环境凭据由原版 `pi-ai` 解析。文件中的 `defaultModel` 优先于这两个环境变量。修改 `.env` 后需重启服务；修改 `models.json` 后可用 `POST /models/reload` 重新加载。真实调用会使用对应账户额度。

可选：设置 `PI_SERVER_TOKEN` 保护本地 HTTP/SSE 请求，调用方发送 `Authorization: Bearer <token>`。带 Origin 的请求须与显式配置的 `PI_SERVER_ORIGIN` 完全一致；默认不允许任何 Origin，不提供 CORS 代理。

服务可单独指定端口 `npm run serve -- --port 4320`（`0` 为随机端口）。相应设置 `PI_SERVER_URL=http://127.0.0.1:4320`。服务 stdout 输出一行 `ready` JSON，含实际监听地址，便于后续宿主启动。

## 接入 Astron Cowork 的边界

```text
Astron 产品服务 → core_contract → Pie adapter → packages/server → Agent → pi-ai
```

Astron 已注册官方 `pie` provider，并通过独立 HTTP/SSE adapter 连接 Pie。采用与 OpenCode 相同的进程边界：宿主负责产品会话、Core 选择和 sidecar 生命周期，Pie 负责模型循环及自己的 SQLite；adapter 转换统一 Core contract 与 Pie 协议。Pie 不是 amio/OpenCode HTTP 协议的直接替代品。

本次服务提供创建/加载会话、提交/取消的基本操作。HTTP `202` 只表示受理；SSE `turn.settled` 才表示 Agent 已空闲。完整接口和限制见 [服务协议](packages/server/README.md)。

助手和会话保存在 `.pie/agent.sqlite`，使用 Node 内置 SQLite；每个数据目录由单个服务独占。一个助手可有多个会话，每个会话使用独立 Agent 和创建时的助手配置快照；同会话忙时返回 `409`，不同会话可以同时运行。只受模型是否继续发起工具调用约束，不设轮数上限。崩溃后恢复完整消息，遗留执行标记为失败，不自动重跑工具。重启后继续真实会话，会按保存的模型 ID 读取当前模型端点和凭据。

Core 切换使用统一会话转储：源 Core 导出 canonical transcript，目标 Core 导入并校验后，Astron 才原子更新活动绑定；切回时执行相同流程。两个 Core 保留各自数据库，Astron 会话 ID 不变，原生会话 ID 保存在各自 `coreBindings` 中。Astron 会在首次使用 Pie 时懒启动 sidecar，启动前同步工具和模型提供商，停止、重启和异常拉起也由 adapter 管理；Assistant 的 Skill/Subagent runtime 已按产品配置投影。当前还缺会话工作区隔离和完整产品权限策略。Pie 注册 `read/bash/edit/write/grep/find/ls/webfetch/job_output/job_kill` 十个原生工具，以及挂载 Plugin 后的 `skill`；Astron 业务工具仍通过 `PI_TOOLS_DIR` 提供。默认助手暂不启用任何工具。

`webfetch` 从 Amio/OpenCode 的 `packages/core/src/tool/webfetch.ts` 和有界响应读取逻辑适配，源版本为 `2f62e1b6d8186d2c7268011d29041551fe1928e0`。参数为 `url`、可选 `format`（默认 `markdown`，也支持 `text`、`html`）和 `timeout`（秒，默认 30、最大 120）；只接受 HTTP(S)，响应上限 5 MiB。使用 Pie 原生权限确认和取消信号，长结果返回预览并保存完整文本供 `read` 查看。无需 `PI_TOOLS_DIR`，通过 runtime 的 `toolIds` 启用即可。原许可保存在 `packages/local/LICENSES/opencode.txt`，Sidecar 发行时包含在 `.LICENSES.txt` 中。

通过 `POST /plugins/import` 导入 `schemaVersion: 1` 的本地插件目录，再用助手接口配置 `pluginIds` 和工具。`node examples/skill-provenance.ts` 可验证示例 Skill 的加载来源，无需真实模型。Plugin 仅负责组织 Skill，APA/App 命令由 Pie 原生 `bash` 执行；依赖环境需要宿主准备。详见 [Plugin 与 Skill](docs/agent-development.md#plugin-与-skill)。

## 本地运行

需要 Node.js 22.19 或更新版本。

```sh
npm install --ignore-scripts
npm run hydrate:model-data
npm run check
npm run example
```

模型目录的 JSON 数据由原版生成器从公开模型目录获取，默认不提交；新 checkout 需要执行 `hydrate:model-data`，它不会调用付费模型。

包提供 `source` 导出条件，开发时可直接运行 TypeScript：

```sh
node --conditions=source examples/basic.ts
```

`npm run build` 可按依赖顺序构建三个包，使用已生成的模型数据。默认包入口仍指向构建后的 `dist`。

生成 Astron 使用的单文件 sidecar：

```sh
npm run build:sidecar
```

产物为 `dist/pie-agent.exe`（Windows）或 `dist/pie-agent`，旁边同时生成 `.LICENSES.txt`，发行时一并交付。Cowork 发行时将各平台产物放到 `resources/binaries/<platform>/<arch>/`；桌面端启动时同步到 `%APPDATA%/astron-cowork/pie-agent/`，Astron adapter 优先使用该副本，开发环境也可用 `ASTRON_PIE_RUNTIME_EXECUTABLE` 指向本地产物。

## 接入真实模型

将示例中的假 provider 换成需要的 provider，传入 `models.streamSimple`：

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Model not found");

const agent = new Agent({
  initialState: { model, systemPrompt: "You are a helpful assistant." },
  streamFn: models.streamSimple.bind(models),
});
agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
await agent.prompt("Hello");
if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
```

真实调用需要配置相应凭据，例如环境变量 `ANTHROPIC_API_KEY`。Agent 的模型错误通过事件和 `state.errorMessage` 表达；工具抛错会作为工具结果交回模型。更多接口见 [Agent 文档](packages/agent/README.md)。

## 测试与对照

定向执行保留的原版 Agent 测试：

```sh
npm run test:core
npm run test:server
```

`packages/ai/test` 保留上游模型层测试，其中部分会读取环境凭据并调用真实服务；只选择需要的测试文件运行。

完整 Pi 位于相邻的 `../pi-upstream`，保留完整 Git 历史。此处核心源码基线为 `b2602be77cb7b0de45dd616407fd210daa48aa75`；`agent.ts`、`agent-loop.ts`、`types.ts` 和 `stream-fn.ts` 保持该版本的实现，包入口与工程配置按当前范围精简。

原本被 Git 忽略的本地文档和依赖目录保存在 `../pie-local-archive-20260914`。原 MIT 许可见 `LICENSE`。
