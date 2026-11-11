# MCP 预热

状态：已完成。2026-11-07。

## 问题与目标

Host Runtime 注册时 MCP 连接已经在后台启动，但注册请求不等待连接完成。用户紧接着发送首个 Turn 时，Turn 会在 `prepareMcp()` 再等待连接和工具发现，造成首轮额外延迟。

目标是让 `/host-runtimes` 注册复用同一批连接的 `ready` Promise，并在返回成功前确认预热完成；不为每个 Worker 或 Session 重复连接。

## 范围

- 增加可选的 Runtime MCP 预热接口。
- `registerHostRuntimes` 在配置后等待已启用 Host MCP 的连接和工具发现。
- 保持普通 Turn 的 `prepareMcp()`、缓存和错误状态语义不变。

不改 Cowork、MCP 协议、Local Assistant 的独立生命周期或前端展示。

## 验收

- MCP 连接未完成时，Host Runtime 注册请求保持等待。
- 注册返回后，首个 Turn 不再重复等待同一连接。
- MCP 失败仍通过现有状态暴露，不阻塞 Pie 进程启动；仅注册同步请求反映本次预热结果。

## 实际改动

- `McpRuntime` 增加可选 `prewarm()`；Local `McpManager` 等待 `configure()` 已启动的当前 Host MCP 连接和工具发现。
- `Runtime.registerHostRuntimes` 在返回前等待 `prewarm()`；普通 Turn 仍复用同一连接和 `prepareMcp()`。
- `packages/server/test/mcp.test.ts` 增加阻塞 `tools/list` 的回归测试，确认注册请求不会提前返回。

验证：`node --conditions=source --test packages/server/test/mcp.test.ts`，5/5 通过；Worker 相关回归 50/50 通过；`npm run check` 通过。

限制：Pie 进程从持久化 Host Runtime 启动时仍后台预热，不阻塞 HTTP ready；本地 MCP 的工作目录不同于 `process.cwd()` 时仍会按目录建立独立连接；Cowork adapter 未新增独立 `prewarm` 能力，但 Host Runtime 注册请求已等待预热完成。
