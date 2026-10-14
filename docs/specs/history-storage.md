# 历史存储与按需读取（第一阶段）

状态：已完成。更新日期：2026-10-14。

## 问题与目标

当前会话同时持久化 `messages` 和 `tree.nodes[].message`，每次保存整段 JSON，启动又全量读取正文。树保留了旧分支，但增加了正文副本。

本阶段让树节点成为唯一的持久消息记录，`messages` 只是当前路径的工作视图；服务启动只读取会话元信息，按需加载指定会话。例如查看会话 A，不应解码冷会话 B 的消息正文。

## 范围

- 继续使用现有 SQLite，拆分会话元信息与消息节点，增量写入节点和会话状态。
- 保留已有节点身份、父指针、当前叶子、旧分支、导入原文，以及图片和工具结果。
- 保持 tree 切换、独立会话 `/fork`、导入导出、后台任务与异常中断恢复的行为。
- 本次不改压缩算法、闲置 Agent 卸载、Web/Astron 展示协议或 SSE；不引入 JSONL 双写或新依赖。
- 活跃 Agent 暂时仍可持有完整当前路径；本阶段不宣称解决单个长期会话的全部内存增长。

## 实现思路

1. `sessions` 保存元信息、`leafId`、revision、checkpoint 和运行恢复状态，不再内嵌完整消息数组或整棵树正文。
2. `session_entries` 按节点保存 `sessionId`、稳定 `id`、`parentId`、绝对 `seq` 和原始消息。`seq` 用于排序与游标，不代替父指针决定分支路径；导入原文及其关联也必须持久化。
3. 会话摘要、当前路径、游标历史和当前分支完整导出分别读取。启动不解码正文；查看或执行时才加载需要的路径，工作视图不作为第二份历史重复保存。
4. 新增节点与会话叶子、revision 等状态在同一事务中保存；单独修改元信息不重写历史。旧 payload 按会话事务迁移，复用已有节点 ID；没有树的旧会话从原消息建立节点。
5. 启动恢复只加载需要修复的中断会话，保留工具结果未知的事实，不自动重放工具。先完成存储拆分和行为回归，再接入按需读取。

## 验收

- [x] 旧数据迁移后，节点 ID、全部分支、导入内容、图片和工具结果保留；失败事务不留下半迁移状态。
- [x] 新增消息只写新增节点和必要状态；持久数据不再同时保存整段 `messages` 与树正文。
- [x] 启动和会话列表不解码冷正文；读取某个会话不加载其他会话历史，游标分页在数据库层限制读取量。
- [x] tree 切换、`/fork`、当前分支导出及重启恢复与改造前一致；写入失败不推进已持久化的叶子和 revision。
- [x] 后台任务和异常中断恢复不丢历史、不重放工具；补充定向回归测试并记录结果。

## 实施记录

- 2026-10-14：完成本 SPEC 和 `AGENTS.md` 中的轻量 SPEC 规则；业务实现尚未开始。
- 2026-10-14：完成第一阶段，主要改动如下。
- `packages/server/src/store.ts`：新增 `session_entries`，以节点 ID、父指针和绝对 seq 保存消息；仅新增节点序列化写入，元信息与叶子状态同事务提交，提交后才标记节点已保存。旧 payload 逐会话迁移；导入原文放在对应节点，元信息只保留导入边界计数，不重复保存原文数组。
- `packages/server/src/server.ts`：启动只建立元信息索引，首次查看或执行才读取当前路径；树导航临时读取完整树，切换后只保留所选路径。导入替换和删除同时清理对应节点，写入失败恢复工作视图。
- `packages/server/src/session-tree.ts`：节点增加持久化 seq，补充父指针循环检查；`packages/server/src/session-transfer.ts` 从节点原文重建导入前缀，保留重启后的续写 ID 和隐藏的导入原文，模型内部通知仍不导出。
- `packages/server/test/store.test.ts`：新增 13 项回归，覆盖迁移与回滚、仅追加写入、父指针分页、导入续写 ID、冷正文隔离、运行活动恢复及写入失败。测试入口已加入根 `package.json`，同步更新 server README 和 CHANGELOG。

## 验证结果与剩余项

- `npm run check`：通过，包含 Biome、服务与 Web 类型检查、模型数据校验；未运行构建或付费模型请求。
- 在 `packages/server` 执行 `node --conditions=source --test test/store.test.ts test/fork.test.ts test/server.test.ts test/compaction-server.test.ts test/auto-compaction-server.test.ts test/model-override.test.ts test/tools.test.ts`：48 项全部通过，包含真实子进程崩溃恢复、后台子任务、取消与 steer。
- 另执行 `node --conditions=source --test test/store.test.ts test/fork.test.ts test/session-transfer.test.ts`：21 项通过，1 项既有失败。`session-transfer.test.ts:40` 的旧用例仍通过创建接口传入内联 runtime，被已有的宿主注册规则拒绝（400 而非 201）；未改动该测试或放宽接口。新版导入、重启、分支与导出的行为由新增存储测试和现有 fork/model-override 测试覆盖。
- 文档与变更空白校验：`git diff --check`；新增 SPEC 和测试文件单独检查。
- 范围边界不变：游标分页仅接入存储层，HTTP/SSE 仍返回原快照；活跃路径仍完整驻留，闲置会话卸载和单个长期 Agent 的内存上限留待后续阶段。旧消息比较仍沿用原树同步逻辑，本阶段不宣称消除其遍历成本。
- 首次用新版启动会原地迁移旧库；上线前应备份 `agent.sqlite`。不提供旧版服务读写新库的兼容层。方案偏差：无新增阶段或依赖，额外修复了持久化失败时活跃 Agent 消息数组未恢复的问题。

## 参考

- 第二阶段正文回收及工作窗口读取的后续实现见 `docs/specs/compaction-working-history.md`；本文件保留第一阶段完成时的范围与验证记录。

- 调查与后续阶段：`docs/agent-history-memory-design.md`。本 SPEC 只覆盖其中的历史存储与读取，不代表其余阶段已实现。
