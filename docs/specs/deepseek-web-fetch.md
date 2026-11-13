# DeepSeek 网页抓取扩展

状态：已完成（源码与本地模拟验收）

## 问题与目标

Pie 需要一个可复制安装的 DeepSeek 网页抓取工具，让任意支持工具调用的模型读取指定 URL 的 Markdown 内容，并沿用现有的模型密钥配置和外部工具生命周期。

## 本次范围

- 新增 `examples/tools/deepseek-web-fetch.ts`，工具 ID 为 `deepseek-web-fetch`。
- 调用 DeepSeek Fetch API，支持 URL 校验、`webfetch` 权限确认、取消、30 秒超时和 5 MiB 响应上限。
- 优先使用 `models.json` 的 `providers.deepseek.apiKey`，无配置时回退到 `DEEPSEEK_API_KEY`。
- 大结果保留完整文本文件，模型先收到有限预览并可使用原生 `read` 续读。
- 工具安装后可通过助手 `toolIds` 选择；本次不新增默认助手启用项，避免改变已有默认工具集合。

不增加第三方依赖或新 Core API；不调用真实付费服务，不修改原生 `webfetch`。

## 验收方式

- 使用本地 HTTP fixture 验证请求、鉴权、参数边界、响应校验、权限、取消、超时、响应大小和长文本续读。
- 运行定向测试、`npm run check` 和 `git diff --check`。

## 实际改动与验证

- `examples/tools/deepseek-web-fetch.ts`：实现官方 Fetch API 请求、URL 校验、`webfetch` 权限确认、密钥复用、30 秒超时、取消、5 MiB 响应上限、响应校验、错误脱敏和长结果文件续读。
- `packages/server/test/deepseek-web-fetch.test.ts`：使用复制到仓库外带空格目录的工具和本地 HTTP fixture，覆盖工具注册与按 `toolIds` 启用、请求鉴权、URL 边界、权限/密钥/取消、空内容、HTTP 错误、响应格式、长 Unicode 结果、超限、超时和取消。
- `README.md`、`packages/server/README.md`、`docs/agent-development.md`、`packages/server/CHANGELOG.md`：补齐安装、密钥、权限、参数和默认启用边界说明。
- `node --conditions=source --test packages/server/test/deepseek-web-fetch.test.ts`：11/11 通过。
- `npm run check`：通过，包含全仓 Biome、TypeScript 和模型目录校验；`git diff --check` 待最终差异检查。
- 抓取扩展不自动加入默认助手，需通过助手 `toolIds` 或宿主 `runtime.toolIds` 选择；搜索扩展的既有默认启用行为不变。
- 未验收：真实账户 DeepSeek Fetch 请求及计费、已运行服务/Sidecar 安装和 Cowork 发行。未构建、部署或提交。
