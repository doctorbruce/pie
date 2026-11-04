# 同一 Turn 内刷新 Skill 绑定

状态：绑定热刷新与技能/插件清单 user 消息变更发布已完成；Windows x64 已构建并替换 Cowork3/AppData，客户端重启及人工验收待执行。

## 问题与目标

当前助手安装并挂载新插件后，正在执行的 Turn 仍使用旧 Skill 集合。让宿主或本地助手发布的新绑定在当前工具批次结束、下一次模型调用前生效，保留 Agent、Turn 身份、消息和工具执行结果。

## 范围与实现

- 将现有技能简介移出 system；可选宿主 `capabilityCatalog` 与技能清单合并，首次或可见历史中的清单变化时追加隐藏 user 消息，保持历史前缀。清空明确发布空清单，压缩丢失清单后重新注入；不扫描目录、不新增安装流程。
- 内部清单持久化到消息树，但不占用户历史分页条数或可见消息分叉下标。
- 复用 Agent 的 `prepareNextTurnWithContext` 安全边界；共享 Runtime 读取所属助手的最新 Skill 绑定。
- 同步 Skill 提示词索引、`skill_search` 和实际 `skill` 工具；支持空集合首次挂载、更新和移除，遵守本轮 `toolAvailability` 和助手隔离。
- 保留已加载的延迟工具、MCP 连接及本轮动态系统上下文；配置和实际 prompt 在继续模型调用前持久化。
- 安装和产品助手绑定仍属于宿主；宿主须在安装工具返回前完成 runtime 发布。本次不增加插件安装工具、不扫描目录，不热切换模型、权限、MCP 或其他 runtime 字段，不构建或部署 Sidecar。

## 验收与测试决策

- T2：注入 faux 模型配合真实 Runtime/工具循环与本地 SQLite，验证单次提交中发布绑定后立即搜索、读取 Skill；移除后不可再发现/加载；不改 Turn ID 或重放工具。
- 同时验证当前批次保持旧绑定、其他助手隔离、本轮工具禁用、动态上下文、MCP lease 与延迟工具保留、持久 checkpoint、保存失败和刷新期间取消。
- 运行受影响测试以及 `npm run check`；不使用真实模型或付费服务。

## 实施与验证记录

- `packages/runtime/src/runtime.ts` 在模型调用间隙读取所属助手的最新绑定，仅替换 `runtime.skills` 与 `runtime.capabilityCatalog`，保存 checkpoint 后继续；`runtime-store.ts` 新增可选 `turnSystemPrompt` 以保留本轮附加上下文。
- `packages/runtime/src/agent.ts` 原地刷新 Skill 工具和发现索引，复用当前 MCP lease，保留已加载的延迟工具。没有改动底层 Agent loop。
- `packages/server/test/skill-hot-reload.test.ts` 新增 5 项测试；实现前 3 项核心回归失败，实现后全部通过。开发文档、嵌入契约、HTTP 说明和 Runtime changelog 已同步。
- 验证通过：`node --conditions=source --test packages/server/test/skill-hot-reload.test.ts`（5 项）。
- 验证通过：`node --conditions=source --test packages/server/test/agent.test.ts packages/server/test/skill-search.test.ts packages/server/test/tool-search.test.ts packages/server/test/mcp.test.ts packages/server/test/turn-recovery.test.ts packages/server/test/plugins.test.ts`（35 项）。
- 验证通过：`node --expose-gc --conditions=source --test packages/runtime/test/runtime.test.ts packages/runtime/test/runtime-permissions.test.ts packages/runtime/test/turn-recovery.test.ts`（61 项）。
- 验证通过：`node --conditions=source --test --test-name-pattern='host runtime revisions rebuild the agent while preserving session messages|assistant edits reconfigure existing durable sessions before their next turn' packages/server/test/server.test.ts`（2 项）。
- `npm run check` 与 `git diff --check` 通过；无实现范围偏差。未调用真实模型，未实现宿主安装工具，未打包、部署、提交或推送；原有文件工具工作区改动未修改。

### 清单移入 user 与变更发布

- 将原有技能简介和可选宿主插件清单合并为带摘要 metadata 的隐藏 user 消息。每次调用前对比可见历史，首次或变化才追加完整替换清单；历史恢复后去重，清空更新，压缩丢失后重新发布。system 不再包含清单。
- 清单持久化复用原消息树和 Store；分页按可见消息计数，公开分叉下标映射到原始节点。压缩选择 Turn 输入时排除清单，保留真实用户请求。
- T1 + T2：`node --conditions=source --test packages/server/test/compaction.test.ts packages/server/test/agent.test.ts packages/server/test/skill-hot-reload.test.ts packages/server/test/capability-catalog.test.ts`：17 passed，验证首次/变化/空、序列化恢复、同轮更新、插件列表单独变化、稳定 system/历史前缀和压缩输入边界。
- `node --expose-gc --conditions=source --test packages/runtime/test/runtime.test.ts packages/runtime/test/runtime-permissions.test.ts packages/runtime/test/turn-recovery.test.ts packages/server/test/compaction.test.ts packages/server/test/skill-search.test.ts packages/server/test/tool-search.test.ts`：74 passed；该组合与前一组合重叠，不累加。覆盖冷恢复、导入、分叉、分页、Subagent、工具发现和取消持久化。
- `npm run check` 与 `git diff --check` 通过；未调用真实模型或测量缓存命中率，未提交或推送。Windows 交付记录见下文。

### Windows 交付（2026-11-04）

- 用户授权同时替换 Pie/Amio 后，使用 Bun 1.4.3 构建 Pie Windows x64，备份并替换 Cowork3 resources 与 AppData 中的 EXE 和 `.LICENSES.txt`。两处 EXE SHA256 均为 `7ACA916E3900B8E326F4B87C9870D63E5C4C9585BD1CCC98EECEABEB571D3EA2`。
- 替换时没有运行中的 Core。用隔离数据目录验证安装后的程序启动、`GET /health`、空会话列表和 SQLite 创建，检查通过后退出临时进程。首次检查因测试目录未创建 tools 而退出，补齐测试目录后通过；未修改产品代码。
- 回滚、哈希和启动证据：`E:/Projects/cowork3/.artifacts/official-plugin-install-20261104-202831/deployment.json` 与同目录 `smoke-result.json`。开发端需重启以同步新增工具资产；未验证真实模型安装闭环。
