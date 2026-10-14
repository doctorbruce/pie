# 压缩后释放工作正文（第二阶段）

状态：已完成。更新日期：2026-10-14。

## 问题与目标

第一阶段已将完整消息存入 SQLite，但压缩只生成请求投影，Agent、Session 和内存树仍持有旧正文。目标是在 checkpoint 可靠提交后，用摘要、必要的当前回合和近期消息替换工作历史；完整原文仍从存储读取。

## 范围与思路

- 保持现有压缩策略、HTTP/SSE 和导入导出契约，不引入依赖，不做闲置 Agent 卸载或前端分页。
- checkpoint 关联稳定的分支节点和保留边界；新消息按节点身份追加，不将摘要或裁剪后的数组当成原始历史的新分支。
- 先事务保存原文与 checkpoint，再替换 Agent 和执行上下文的工作数组，同时解除 Session/树的旧正文引用。摘要失败、取消或提交失败不得裁剪。
- 重启按 checkpoint 加载工作窗口；fork、导出、树导航和完整历史快照直接读存储，临时读取不写回工作窗口。
- 保留工具调用/结果配对、当前输入和图片、已曝光工具、后台通知和连续压缩语义。正文可释放不等于 RSS 必须立即下降。
- Agent 增加 `replaceMessages()`：仅在请求间隙或空闲时替换工作正文，同时清理 loop 的上下文与本轮累计结果；使用该方法后，`agent_end.messages` 只包含本轮仍保留的消息，未调用时原契约不变。

## 验收

- [x] 连续多次压缩后，Agent 和 Session 只保留工作窗口，原消息仍可完整导出；摘要不成为原始树节点。
- [x] checkpoint 与新增原文事务提交，失败或取消保留原工作历史；重启恢复正确窗口和分支。
- [x] 裁剪前的消息仍可 fork/树导航，完整快照不污染工作窗口；工具、图片和导入原文保留。
- [x] 覆盖重复压缩、运行中的工具链、取消/失败、重启、fork/导出及正文引用回收的定向测试。

## 实施记录

- 2026-10-14：建立 SPEC，开始检查存储、压缩及 Agent loop 的正文持有者。
- 2026-10-14：`store.ts` 增加只读节点身份和工作窗口查询，checkpoint 与新增原文仍同事务提交；冷前缀不解码。`server.ts` 按消息对象身份追加节点，弱引用索引不持有正文，内存树只留叶子；完整快照、导出及分叉改为临时读取存储。重启依稳定节点边界恢复；第一阶段的索引 checkpoint 在首次工作读取时转换边界 ID。
- `compaction.ts`/`agent.ts` 区分已物化的工作窗口，提交成功后同步替换 Session、Agent、loop 和请求数组；重复压缩只合并上一摘要与新增历史，不重复摘要 checkpoint。`tool-search.ts` 从 checkpoint 的工具名清单恢复曝光状态，并过滤当前不允许的工具。
- `packages/agent` 增加 `replaceMessages()` 和请求间隙上下文绑定。只改 Agent 状态仍会被 loop 的累计结果留住，因此本次包含执行内核的小接口扩展；新 API 的累计结果语义见其 README/CHANGELOG。
- 新增 `working-history.test.ts`、`message-replacement.test.ts`，扩展压缩测试及测试入口。WeakRef + 显式 GC 验证运行中的工具链及真实服务压缩后冷消息对象可回收；测试先清除 mock 自身保存的旧参数，避免把测试引用误判为服务泄漏。
- 验证：根 `npm run check` 最终通过（Biome、TypeScript、Web 类型及模型数据校验）。检查曾发现新增测试缺少必填 `runtimeSource`，已补齐；没有修改依赖或模型元数据。`git diff --check` 通过。
- 在 `packages/agent` 执行 `node ../../node_modules/vitest/dist/cli.js --run test/message-replacement.test.ts test/agent.test.ts test/agent-loop.test.ts`：46 项全部通过，原有 Agent/loop 契约回归保留。
- 在 `packages/server` 执行 `node --expose-gc --conditions=source --test test/working-history.test.ts test/store.test.ts test/fork.test.ts test/compaction.test.ts test/compaction-server.test.ts test/auto-compaction.test.ts test/auto-compaction-server.test.ts test/server.test.ts test/model-override.test.ts test/tools.test.ts test/tool-search.test.ts test/mcp.test.ts`：75 项全部通过。包含真实服务连续压缩、重启和裁剪前 fork/tree、事务失败与取消、图片、导入原文、工具曝光、后台子任务及 GC；仅用本地端点或 faux，无付费请求。最初工作树的 80 项结果包含另一个功能的 5 项测试，未纳入本次提交。
- 2026-10-14 交付验收：将暂存内容导出到隔离快照，`npm run check`、上述 46 项 Agent 测试和 75 项服务测试通过；`npm run build`、`npm run build:sidecar -- --out E:/Projects/pie/dist/pie-agent.exe` 通过。快照的 workspace 依赖链接指向快照自身，未修改主工作树依赖或 lockfile。
- 从仓库外启动生成的原生 EXE，以临时数据目录、本地模型端点及 faux 验证 SQLite、原生 read 工具、连续压缩、完整导出、冷历史 fork/tree 和重启续写：全部通过；压缩 generation 为 2，原始消息保留 8 条，fork 保留 2 条，随附 LICENSES 校验通过。本次提交仅包含历史存储与正文回收两阶段，未部署、重启正在运行的 Sidecar 或推送。
- 第一阶段 SPEC 记录的旧 `session-transfer.test.ts` 内联 runtime 用例不在本次验收命令中，未改动或放宽其接口。
- 剩余：HTTP/SSE 仍完整读取、推送快照；fork 仍临时解码、复制原文，未做 SQL 前缀复制优化。活动记录、后台任务和闲置 Agent 的内存上限不在本阶段；没有声称 RSS 立即下降。实现偏差：增加了必要的 Agent 工作历史替换 API，未新增依赖或协议分页。

## 参考

- 第一阶段：`docs/specs/history-storage.md`；总体调查：`docs/agent-history-memory-design.md`。
