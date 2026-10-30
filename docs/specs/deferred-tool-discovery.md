# 延迟工具发现目录

状态：已完成（源码验收）

## 目标与范围

仅有通用 `tool_search` 说明时，模型可能不知道未展示的具体工具。由 Core 在每次模型请求前，将当前可发现且尚未加载的工具 ID 和一句简介追加到 `tool_search.description`，不修改宿主 system prompt，不提前暴露工具参数 schema。

目录继承当前工具选择与 MCP 连接库存，不列未选工具、停用 MCP 或实际请求上下文中已移除的工具；执行确认策略、搜索算法、加载与恢复协议保持不变。

## 每轮工具可用性

用户 Turn 请求可传入按精确工具 ID 匹配的 `toolAvailability` 布尔映射，不支持通配符。每次 submit 从最新宿主或本地助手配置合成该轮 RuntimeConfig，再应用本轮映射；false 同时排除实际工具、搜索候选和目录，true 不能扩大助手原有工具选择、挂载范围或权限。业务工具和原生 MCP 工具经过同一轮边界筛选。

映射随 Session runtime 和 Turn checkpoint 保存，不写回宿主定义，也不影响其他 Session；下一轮重新合成，可恢复此前临时禁用的工具。Steer 沿用本轮映射，子助手继承父轮 false 边界，保留执行时的 permissions/context.ask 确认。

## 实现

在 `packages/runtime/src/tool-search.ts` 的 `expose` 中，根据当前 context.tools 与 loaded 状态生成目录，按 ID 排序。简介取首个非空行、压成单行并最多保留 160 字符。统一使用 `Deferred tools available to load:` 和 `- <id>: <brief>` 格式；没有待加载工具时只保留通用说明。

## 验收

- 真实 SDK 发往本地 provider 的请求包含启用工具目录；未选或移除工具、停用 MCP 不出现。
- 工具加载后的下一次请求从目录移除该工具；配置刷新和会话恢复反映当前库存，目录不重复追加。
- 本轮 false 排除工具、目录和搜索；下一轮可恢复，true 不扩大原有范围，其他 Session 不受影响，Steer 与子助手保留本轮边界。
- system prompt 保持原样，完整 schema 继续延迟加载，MCP 服务说明继续随搜索结果返回。
- 运行 `node --conditions=source --test packages/server/test/tool-search.test.ts`、`npm run check` 和 `git diff --check`。

## 实施与验证记录

- 已在 `createToolSearch.expose` 按当前请求工具集与 loaded 状态生成目录，仅替换模型侧 `tool_search.description`，保留执行包装与原始通用说明。
- 已在 `protocol.ts`、`runtime.ts` 和 `agent.ts` 补齐本轮 `toolAvailability` 输入、持久化与实际工具库存筛选；历史 loaded 不绕过本轮禁用，Steer 与子助手保留边界。
- 已扩展现有 provider 请求测试和简介边界测试。先运行测试复现目录缺失（2 失败、2 通过）；实现后同一命令 4 项全部通过。
- provider 测试也验证本轮同时禁用业务工具与原生 MCP 后，ID、简介和搜索结果均排除，下一轮省略映射后恢复。
- `node --conditions=source --test packages/runtime/test/runtime.test.ts`：41 项全部通过，新增的每轮边界、子助手和 checkpoint 回归先红后绿。
- `npm run check` 完整通过（Biome、类型检查、模型数据），`git diff --check` 通过。
- 简介为空时回退工具 ID；现有简介测试覆盖空描述、单行归一和 160 字符截断，4 项 tool-search 测试全部通过。
- 已运行 `npm run build:sidecar:bun`，Windows amd64、Darwin arm64 和 Darwin amd64 三目标及对应 LICENSES 生成成功；Windows 使用 `--port=65536` 按预期退出 1，未启动服务。启动时仍有既有 canvas/DOMMatrix/Path2D 警告，Darwin 产物未在本机执行。
- 本次范围内无未完成项；未部署或提交。
