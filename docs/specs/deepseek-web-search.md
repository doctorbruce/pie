# DeepSeek 网页搜索扩展

状态：已完成（源码与本地模拟验收）

## 问题与目标

Pie 已有网页抓取工具，但缺少可独立使用的 DeepSeek 网页搜索工具。提供一个可复制安装的外部工具，任意模型均可通过现有工具调用链使用。

## 本次范围

- 新增 `examples/tools/deepseek-web-search.ts`，工具 ID 为 `deepseek-web-search`，沿用 `PI_TOOLS_DIR`、助手 `toolIds` 和按需曝光机制。
- 工具已安装时，默认助手自动启用 `deepseek-web-search`；未安装时保持空工具列表，其他助手不受影响。
- 调用 `POST https://api.deepseek.com/v1/tools/search`，优先使用 `models.json` 的 `providers.deepseek.apiKey`，没有该配置时回退到服务端 `DEEPSEEK_API_KEY`。
- 支持官方 `query/count/ori_question/localization/need_content` 参数，保留 query 中的站点、语言、日期等搜索语法。
- 使用现有 `websearch` 权限确认，提供 30 秒网络超时、取消、5 MiB 响应上限、50 KiB 模型预览与完整长结果文本文件。
- 校验响应、报告 HTTP 错误，搜索无结果为正常结果；使用本地模拟服务验收。

不增加第三方依赖、工具框架、其他默认启用项或新 Core API；不实现 DeepSeek Fetch，不修改 Cowork 工具发行，不调用真实付费服务。

## 实现与验收

- 工具仅使用标准库、注入的 `Type` 和可擦除类型导入，可脱离仓库复制运行。
- 定向测试覆盖复制加载与注册、工具选择、请求与鉴权、参数和响应校验、权限拒绝、错误、长结果通过原生 `read` 续读、超时和取消。

## 实际改动与验证

- `examples/tools/deepseek-web-search.ts`：实现上述参数、鉴权、权限、网络限额、响应校验与错误脱敏；不自动重试计费请求。
- `packages/server/test/deepseek-web-search.test.ts`：工具复制到带空格的仓库外目录加载，使用本地 HTTP fixture 和 faux Agent 验证注册与按配置启用。
- `packages/local/src/store.ts`、`packages/local/src/runtime.ts`：工具已安装时，首次创建或尚未配置工具的“默认助手”自动加入 `deepseek-web-search`；未安装时保持空列表，其他助手不变。
- 根 README、`packages/server/README.md`、`docs/agent-development.md` 与现有 Server Changelog：补齐安装、环境变量、启用与边界说明。
- `node --conditions=source --test packages/server/test/deepseek-web-search.test.ts`：12/12 通过（含外层测试容器）。覆盖 Unicode 参数边界、密钥跨错误截断边界脱敏、长结果原生 `read` 分页、响应超限、取消与超时，以及无关外部工具的环境隔离。
- `node --conditions=source --test packages/server/test/default-tools.test.ts`：通过。覆盖未安装时保持空列表，以及已有默认助手在安装工具后自动启用。
- `npm run check`：通过，包含全仓 Biome、TypeScript 和模型目录校验；`git diff --check` 通过。
- Web 配置复用：现有模型设置页的 `deepseek` 提供商 API Key 保存到同一个 `models.json`，搜索工具创建时读取该配置；仍保留 `DEEPSEEK_API_KEY` 环境变量回退。
- 实现调整：长结果由原计划的 JSON 文件改为保留全部字段的折行文本，每行最多 1000 个 Unicode 字符，避免原生 `read` 的 2000 UTF-16 单元行截断导致正文无法续读；默认助手只在该扩展已注册时启用搜索工具。
- 未验收：真实账户的 DeepSeek Search 请求及计费、已运行服务/Sidecar 安装和 Cowork 发行。未构建、部署、重启或提交。
- 密钥复用：`packages/local/src/agent.ts` 在创建外部工具时解析 `providers.deepseek.apiKey`（包括 `$ENV_VAR` 模板）并注入工具上下文；Web 沿用现有模型提供商密钥输入和脱敏查询。

接口依据：[官方指南](https://api-docs.deepseek.com/zh-cn/guides/search/)、[Search API](https://api-docs.deepseek.com/zh-cn/api/search/)。
