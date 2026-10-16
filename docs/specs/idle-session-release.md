# 闲置会话卸载与按需重建

状态：已完成。更新日期：2026-10-16。

## 问题与目标

历史存储拆分和压缩正文回收已经完成，但回合结束后 `session.agent` 与 `session.messages` 仍持有工作历史。云端存在大量闲置会话时，持久化成功并不等于正文可以回收。

本次延续 [历史存储](history-storage.md)、[压缩后正文回收](compaction-working-history.md) 和 [总体内存设计的运行时释放阶段](../agent-history-memory-design.md)，不另建历史或 Loop。目标是允许宿主选择：按需读取工作窗口 → 重建 Agent → 执行 → 提交结果 → 安全卸载；本地默认继续复用内存。

## 范围与不做

- Runtime 新增 `sessionRetention: "retain" | "release-after-turn"` 选项，默认 `retain`。云端宿主显式选择卸载，通过既有 `RuntimeStore` 注入 Redis / SQL；Runtime 不识别数据库类型。
- 卸载仅解除 Agent、消息和导入正文等引用，并标记工作历史未加载；保留会话身份、叶子、checkpoint、运行配置和订阅，不删除持久历史、不关闭共享 MCP / 存储。
- 成功、失败或取消的回合都必须先成功保存终态。写入失败保留内存并沿用现有停止写入语义；有在途执行、排队消息、待确认或相关后台任务时不卸载。
- 下一轮、Subagent 续写和后台完成通知复用现有工作窗口读取与 Agent 工厂。创建、导入、分叉、树切换或元信息写入后也不能重新留下闲置正文。
- 不实现 Redis / SQL 适配、跨节点所有权、TTL / LRU、前端分页或新事件协议；不限制活动记录 / 后台作业缓存，不承诺 RSS 立即下降。本次不自动同步 Cloud 副本或部署 Sidecar。

## 实现思路

- 在共享 Runtime 统一管理执行 Promise 和卸载检查，最终提交与事件收尾完成后释放；下一轮接纳及后台通知不能越过上一轮收尾。
- 先提取 Subagent 最终输出，再卸载其 Agent。后台任务期间保留必要执行状态，完成通知重新进入同一接纳通道，不能丢通知、重复执行工具或清掉新回合的 Agent。
- 复用 `readWorkingPath`、稳定消息节点和 checkpoint；卸载后把 `historyLoaded` 设为 false，防止下一轮误用空消息。完整浏览、导出和分支操作仍临时读取持久历史。

## 验收

- [x] 默认策略跨轮复用 Agent；卸载策略每轮重建并读取工作历史，消息、图片、节点、分支和 checkpoint 不丢失。
- [x] 成功、取消、失败、提交失败和收尾期间新提交的行为正确；失败写入不清掉未保存正文。
- [x] 前台 / 后台 Subagent、续写、后台通知和确认保持正常，无工具重放。
- [x] 使用 WeakRef 与显式 GC 验证卸载后的 Agent 和消息可回收；活跃或未保存数据仍被保留。
- [x] 定向 Runtime / 存储 / 分支 / 压缩回归及 `npm run check` 通过，不调用收费模型。

## 实施记录

- 2026-10-16：核对既有 SPEC；本次是历史内存路线的后续卸载阶段，不改变前两阶段已经完成的存储与压缩语义。实现与验证待完成。
- `packages/runtime/src/runtime.ts` 已加入保留策略、统一执行收尾与安全卸载；后台通知有序接纳，Subagent 在卸载前返回文本结果，冷操作复用原工作历史读取。`packages/runtime/test/runtime.test.ts` 定向 15 项通过，显式 GC 验证 Agent / 正文可回收，并覆盖默认保留、失败写入、取消、重建、分支、Subagent 续写和后台通知。完整检查与本地兼容回归待完成。
- 完成验收：`node --expose-gc --conditions=source --test packages/runtime/test/runtime.test.ts` 15 项通过；`npm run test:server` 157 项全部通过，覆盖真实 SQLite、压缩、分支、MCP、工具与本地 HTTP / SSE 回归；`npm run check` 通过，包含 Biome、Runtime / Web 类型与模型数据校验；`git diff --check` 通过。未调用收费模型，未构建、部署、提交或推送。
- 文档入口：`docs/runtime-embedding.md` 给出云端启用选项和资源归属，`packages/runtime/README.md` / `CHANGELOG.md` 记录默认保留与显式卸载。旧阶段 SPEC 仅补后续链接，不重写历史验收结论。
- 偏差与剩余：采用显式策略和既有存储接口，没有引入 TTL / LRU、外部依赖或新存储方法。运行中 / 后台作业及失败写入仍保留必要内存，活动记录与宿主自行保存的快照不在释放范围；未测量 RSS。Cloud 副本同步、真实 Redis / SQL 接入与生产装配仍由后续接入完成。
