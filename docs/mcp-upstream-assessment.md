# 上游 Pi MCP 复用调查

核验日期：2026-10-12。上游为 `earendil-works/pi`，已 fetch 的 `origin/main` 为 `4270522473e677ddba7b093caa0064a3df51d459`。调查通过 Git 对象读取该提交，没有切换本地旧工作树。

## 结论

可以复用。建议只引入独立的 `packages/mcp`，适配 Pie 的工具、权限、配置与生命周期；不升级整个 Pi Agent Core，不复制 coding-agent 的整套 MCP 扩展。

本轮只有调查，没有实现或部署 MCP。源码可移植性不等于 Sidecar 打包、Windows 进程回收和真实 MCP 调用已验证。

## 版本与来源

- 原生 MCP 引入提交为 `8562bcf66a8eeefdf75ddd231ca9d7aa7d64f86e`，时间为 2026-09-29 07:12:50 UTC；首次发布 v0.99.0 为 2026-09-29 17:21:54 UTC，即香港时间 9 月 30 日 01:21:54。[官方发布](https://github.com/earendil-works/pi/releases/tag/v0.99.0)
- 截至核验时，直接请求 GitHub releases/latest 与官方 npm registry 得到的最新正式版均为 1.1.0，分别发布于 2026-10-07 22:26:31 UTC 与 22:14:39.812 UTC。[官方发布](https://github.com/earendil-works/pi/releases/tag/v1.1.0)
- main 虽仍标记 1.1.0，但含 2026-10-10 的 OAuth `iss` 校验修复 `c5f5b3282d5e4203c085e59837ba17aeaf2829b5`；该修复属于 Unreleased，不在正式 1.1.0 内。若同步 OAuth，应采用包含该修复的固定源码提交，或在已发布包上明确携带对应补丁，不能把 main 等同于 npm 1.1.0。[CHANGELOG](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/mcp/CHANGELOG.md#L3)

## 可直接复用的底层

- 独立 `@earendil-works/pi-mcp` 不依赖官方 MCP SDK 或其它 Pi 包；唯一直接运行时依赖是 `cross-spawn@7.0.6`，Node 最低版本为 22.19.0，与 Pie 一致。[package.json](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/mcp/package.json)、本地 `package.json`。
- 协议客户端支持初始化、分页工具发现、调用、超时、取消、进度、资源读取及文本/图片转换；有 stdio 和 Streamable HTTP transport，可注入 fetch 和 headers。独立 OAuth 子入口提供发现、PKCE、动态注册和 token 刷新，但不负责打开浏览器或选择凭据存储位置。[README](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/mcp/README.md)
- 可以直接引用固定版本包，或按 Pie 现有抽取源码的方式增加 `packages/mcp`；后者应保留上游测试和适用许可。当前接入涉及 OAuth 时，优先采用上述包含修复的固定源码提交。

## 需要适配，不能照搬

### 工具桥接

上游 `coding-agent/src/extensions/mcp/tools.ts` 还依赖 pi-tui、Extension ToolDefinition、交互渲染、快捷键与输出文件工具，不是可直接嵌入 Pie Server 的纯协议模块。只复用或抽取命名、schema 归一化、进度、内容转换与截断行为；保留 Pie 已有 tool_search，不带入 TUI/CLI、扩展系统或 codemode。

上游工具名为 `mcp__<server>__<tool>`，最大 64 字符，超长或清洗后冲突使用哈希后缀，不能替换为不处理冲突的机械截断。[tools.ts](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/coding-agent/src/extensions/mcp/tools.ts#L84)

当前 Pie `packages/agent/src/types.ts:362` 的 AgentToolResult 没有新上游的 isError/structuredContent；`packages/agent/src/agent-loop.ts:707` 将所有正常 resolve 的结果标记成功。上游 MCP wrapper 返回 isError=true 时不抛错，直接复制会把 MCP 业务失败算成成功。须适配到现有异常语义，或在不破坏 skill 的 afterToolCall 链路中明确投影失败与结构化结果，不为此机械升级整个 Core。[上游结果转换](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/coding-agent/src/extensions/mcp/tools.ts#L210)

### Astron 与 Pie 的接入点

1. 配置投影：为 `/host-runtimes` 的 runtime 增加 MCP，按 Assistant/群聊实际授权选择服务，不向所有 owner 无条件开放全部配置。Astron `adapters/pie/runtime_config.py:248` 当前没有 MCP 字段；可参照 OpenCode 的设置与插件索引合并及归一化：`adapters/opencode/runtime_config_builder.py:72`、`:438`。
2. 连接和工具：异步发现 MCP 工具，包装成 AgentTool，接入现有 tool_search、权限交互和取消信号。Pie `packages/server/src/agent.ts:138` 目前同步创建并校验静态 toolIds，`:227` 构建 tool_search，因此仅塞入新工具 ID 不会形成可用 MCP 工具。
3. 状态与刷新：实现真实 MCP 状态 API，替换 Astron `adapters/pie/transport.py:119` 的固定空结果，并补 MCP_STATUS 能力声明。按 owner/配置版本管理连接，刷新不得误关活跃 turn 仍使用的连接，退出与停用须回收进程和网络连接。
4. OAuth：复用底层 OAuth，授权交互交给现有宿主，凭据写入 Core 私有存储，不复制上游 CLI 的目录和 UI。

上述 Astron 相对路径位于 `engine/servers/astronverse-agent/src/astronverse/agent/`。

## 兼容性和许可边界

- 上游明确不支持 legacy HTTP+SSE、batch JSON-RPC、MCP server、sampling、tasks。Streamable HTTP 内部 SSE 重连不是旧 HTTP+SSE transport，不能对现有 `/sse` 服务宣称兼容；需明确报不支持或另加 transport。[README](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/mcp/README.md#L132)
- 包声明 MIT；根 LICENSE 的 Mario Zechner 版权和许可须保留。OAuth 改编自官方 TypeScript SDK v1.29.0，还须保留其 Anthropic, PBC 版权及第三方许可。分发 bundle 时也应携带适用许可。[根 LICENSE](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/LICENSE)、[第三方许可](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/mcp/LICENSES/modelcontextprotocol-typescript-sdk.txt)
- Windows stdio 有 cross-spawn、windowsHide 与 taskkill /T /F，但 exitHook 仅在非 Windows 进程组分支注册，Windows 进程树强制回收测试被跳过。不能由这些静态分支推断异常退出也会完整回收 Windows 子进程。[stdio.ts](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/mcp/src/transports/stdio.ts#L19)、[stdio 测试](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/mcp/test/stdio.test.ts#L30)
- Pie Sidecar 使用 esbuild CJS bundle + Node SEA；Node 版本一致是可行性依据，不是 EXE 验收。仍需验证真实 Windows 启停、工具调用和子进程回收。

## 测试事实与本轮验证

上游 packages/mcp/test 有 5 个测试文件，覆盖客户端生命周期、分页、资源、错误、取消/进度、内容、stdio、HTTP 会话/重连与 OAuth；CI 为 Ubuntu + Node 22。Conformance 基线是 26 个场景、261 个 passing checks 和 8 个已知 failing checks：elicitation 6 项、CIMD 1 项、scope-retry-limit 1 项。该套件明确不覆盖/不实现 2026-07-28 stateless protocol，不能描述成全部 MCP 符合性通过。[测试目录](https://github.com/earendil-works/pi/tree/4270522473e677ddba7b093caa0064a3df51d459/packages/mcp/test)、[conformance](https://github.com/earendil-works/pi/tree/4270522473e677ddba7b093caa0064a3df51d459/packages/coding-agent/test/mcp-conformance)

本轮只新增调查文档，没有安装依赖、修改业务代码、运行上游测试或构建 EXE。无需新增行为测试。实施阶段应使用本地 fixture MCP 服务和 faux provider 验证 stdio/HTTP 发现与调用、业务失败、取消/超时、owner 权限隔离、刷新与旧连接回收、状态回传，以及 Windows Sidecar smoke，不调用收费模型或真实凭据。
