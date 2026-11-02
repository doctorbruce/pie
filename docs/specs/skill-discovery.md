# Skill 搜索与发现

状态：已完成（源码验收）

## 问题与目标

Pie 只有提示词中的技能摘要和按 ID 加载正文的 `skill`，没有独立的技能搜索入口。模型查询可用能力时可能转而遍历插件或技能目录。补充共享 Runtime 的 `skill_search`，使本地、嵌入和 Subagent 只从当前已挂载技能中发现能力。

## 范围与实现

- 保留现有技能摘要索引和 `skill` 加载、来源记录；新增工具不读取磁盘、不加载指引、不记录 `skill_load`。
- `skill_search({ query, limit? })` 搜索绑定 ID、技能名称及各语言描述；精确绑定 ID 优先。空查询或 `list/all/skills/技能/技能清单` 列举当前技能。
- 返回 `{ skills: [{ id, name, description }], total, shown, truncated }`；描述沿用宿主语言选择规则。`limit` 为 1–100，默认搜索 20 条、列举 100 条。
- 有挂载技能时提供常驻工具；遵守本轮 `toolAvailability`。中文、英文提示词指导先发现、再按精确 ID 加载，不扫描目录发现技能。
- 将 `skill_search` 加入工具保留名；更新现有开发与嵌入文档。不新增依赖，不修改 Cowork，不构建、部署或重启运行时。

## 验收与测试决策

- 风险：发现未挂载技能、跨会话混入、搜索意外读取正文或记为加载、禁用工具仍被模型调用。
- T1：关键词、列举、本地化、重名绑定、结果限制与范围隔离。
- T2：真实 Agent loop 参数校验、工具曝光和禁用、搜索后加载及来源记录；使用 faux provider，不调用真实模型。
- 运行新增测试及既有 Agent、Plugin、工具发现和共享 Runtime 相关测试，再执行仓库要求的 `npm run check`。

## 实施与验证记录

- `packages/runtime/src/skills.ts` 提供纯内存发现及共用的宿主语言描述选择；`packages/runtime/src/agent.ts` 注册常驻工具并添加中英文发现指引，本轮禁用时不提示调用该工具。
- `packages/local/src/agent.ts` 与共享 Runtime 的工具目录校验保留 `skill_search` 名称，防止宿主工具覆盖。现有 Skill 正文读取和来源记录保持原实现。
- 已同步开发文档、嵌入说明、Server README 和 Runtime CHANGELOG。
- 新增 `packages/server/test/skill-search.test.ts`：先复现缺少工具（4 项失败），实现后 5 项全部通过。覆盖不存在目录、多语言与完整描述、精确 ID 大小写、限额、会话隔离、共享宿主、禁用和参数校验、保留名冲突。
- `node --conditions=source --test packages/server/test/skill-search.test.ts`：5 项通过。
- `node --conditions=source --test packages/server/test/agent.test.ts packages/server/test/tool-search.test.ts`：8 项通过；Agent 测试补充搜索返回 ID 后加载完整正文与来源记录。调整测试断言后单独复跑 `agent.test.ts`，4 项通过。
- `node --conditions=source --test --test-reporter=dot packages/runtime/test/runtime.test.ts packages/server/test/plugins.test.ts packages/server/test/external-tools.test.ts`：通过。
- `npm run check`：Biome、TypeScript 和模型数据检查全部通过。`git diff --check` 通过。
- 本次源码范围无未完成项或设计偏差。未调用真实模型，尚未验证模型实际选择搜索入口的行为；未构建、部署、重启或提交，已运行的 Sidecar 需更新产物才会生效。
