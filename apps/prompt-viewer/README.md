# Pie Core Prompt 历史查看器

独立、只读、无第三方依赖。不会提交 prompt、调用模型、写入数据库或改变会话状态。

## 日常使用

需要 Node.js 22.19+（推荐 24）。在仓库根目录运行：

```powershell
npm run prompts
```

打开 `http://127.0.0.1:4319`。Windows 自动发现运行中的 Astron `pie-agent.exe` 端口；没有发现时使用 `http://127.0.0.1:4318`。多个 Core 同时运行时，在页面连接设置中指定地址。Core 重启换端口后，地址留空并刷新即可重新发现。

也可以显式指定 Core 地址或查看器端口：

```powershell
npm run prompts -- --core-url http://127.0.0.1:52051 --port 4319
```

可通过 `PI_SERVER_URL` 配置地址；需要认证时通过 `PI_SERVER_TOKEN` 或页面的令牌输入框提供令牌。令牌不会写入浏览器存储，也不会放进 URL。页面输入的地址仅允许 `http://127.0.0.1:<端口>`；桥接器不转发任何写操作。

查看器也可脱离仓库使用：保留 `server.mjs` 和 `index.html` 在同一目录，用 `node server.mjs` 启动，不需要安装 npm 依赖。关闭终端或按 Ctrl+C 停止服务。

## 展示内容

- 按更新时间浏览历史会话，搜索标题、ID 或助手；可显示子会话。
- 实际模型请求：按调用选择完整 payload，包括最终系统指令、当次历史、动态工具定义和请求参数；上下文压缩调用单独标记。
- 用户 Prompt：逐条查看、筛选、复制用户输入，保留图片附件说明。
- 已保存系统指令：会话最后保存的 `runtime.systemPrompt`、技能/工具配置、上下文压缩摘要。
- 完整消息：用户、助手、思考文本、工具调用及返回结果，支持查看原始消息 JSON。
- 会话 JSON：完整保存快照，可导出并在以后离线导入；内容只在本机处理。

## 完整请求如何保存

更新到含请求记录功能的 Pie Core 后，每次提供商适配器准备好请求、即将交给 SDK 发送时，自动保存其 `onPayload` 参数。记录不截断、不修改请求，不重排系统指令、历史或工具。摘要生成也记录，子会话按自己的 ID 隔离。

记录保存在 `<PI_DATA_DIR>/model-requests/<会话 ID 的 SHA256>/<时间戳>-<UUID>.json`；未设置 `PI_DATA_DIR` 时使用 `.pie`。不会写入会话数据库。每条包含会话 ID、提供商、模型、API、时间、用途和完整 payload，不额外保存认证头、API Key 配置或环境变量。

查看器自动搜索本地 `.pie` 和 Windows Astron 账号数据目录。自定义目录或多个目录包含同一会话时，明确指定记录根目录：

```powershell
npm run prompts -- --core-url http://127.0.0.1:52051 --requests-dir 'C:\path\to\pie\data\model-requests'
```

**旧二进制不会记录，改源码不会更新已运行的 Core。** 需要发布/替换 Sidecar 并重启。此前没有记录的请求无法从会话快照精确还原，页面明确显示无记录，不会用历史消息补造。

记录代表发送前准备完成，不证明服务端接收成功；SDK 内部复用同一 payload 的重试不会产生新记录。不同提供商的 SDK 可能进一步编码请求，这里展示的是提供商适配器最终参数，不是原始 HTTP 报文；代理随后添加的计费字段也不在其中。写盘失败会警告但不阻止模型调用。

“导出本次完整请求”导出当前选中的请求记录；在线时“导出会话”只导出会话快照，不包含所有请求。离线时导出会话会保留已导入的请求。可以保留请求 JSON，以后直接导入 HTML 查看。

记录包含完整私人输入、历史、附件和工具输出；如果这些内容本身含密码，也会原样保存。记录没有自动过期策略，磁盘使用会持续增长；删除会话不会自动删除独立的请求文件。仅保留在可信本机目录，不要上传第三方或提交进仓库。

## Core 离线时

只读打开指定数据目录的 `agent.sqlite`：

```powershell
npm run prompts -- --data-dir 'C:\path\to\pie\data'
```

运行中的 Core 独占 SQLite，离线模式此时会明确报错；应使用在线模式，不复制活跃数据库、不更改锁设置。查看器以 `readOnly` 和 `query_only` 打开库，不会创建或迁移数据库。

也可以双击 `index.html`，导入本查看器导出的一个或多个 JSON 文件。直接打开 HTML 时无法在线连接 Core；刷新页面后需重新导入。导入支持完整请求记录、单个会话快照、数组或 `{ "sessions": [快照] }`；同一会话的多条请求会合并。不支持 `/sessions/:id/export` 的跨 Core 传输格式或只有摘要的会话列表。

导出的 JSON 可能包含私人对话、路径及运行配置中的凭据。不要上传到第三方网站或提交进仓库。

## 验证

```powershell
node --test apps/prompt-viewer/test/server.test.mjs
node --conditions=source --test packages/server/test/model-requests.test.ts
```
