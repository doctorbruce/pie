# 单会话按需装载

状态：已完成（PIE 侧）；Cloud 接入待实施。日期：2026-10-24。延续 [远端 Loop 演进](remote-loop-evolution.md) 的 P1。

## 问题与目标

此前工作正文已能按需读取，但 Runtime 启动仍通过 `loadSessions()` 创建全部 Session，SQLite 也保留全部元信息。云端用户即使只访问一个会话，也承担该用户全部会话的装载和驻留成本。

目标是启动不扫描全部会话元信息，按 ID 装载指定 Session，列表独立分页；启用 `release-after-turn` 时，可靠结算后连同空闲 Session 一起释放。本地继续默认复用已访问会话的内存状态。

## 范围与不做

- 修改共享 RuntimeStore / Runtime、SQLite 适配、本地装配及对应回归；保留现有 HTTP 列表行为与 Turn 恢复语义。
- Store 新增按 ID 查询和基于 `updatedAt + id` 的游标分页，支持助手、会话类型、父会话过滤；不把列表结果放入执行缓存。
- 会话订阅改为异步装载；执行、确认、后台任务、订阅和失败写入保护仍在使用的对象。删除父会话时查询存储中的子会话，不只遍历已装载对象。
- SQLite 仅迁移旧内联正文、修复运行中 Turn / Activity；不在启动保留全量元信息数组。显式管理查询可以扫描元信息，但不能变成常规装载依赖。
- 不同步或覆盖 Cloud 工作树，不实现云端数据库、跨实例归属、自动接管、Cloud 事件链路或超长 Turn 的有界恢复扫描。

## 实现与验收

- 空 Runtime 的创建不调用会话列表；首次访问只读目标元信息，缺失返回 404，尚未由宿主修复的 running Turn 在目标装载时返回 409，不阻塞其他会话。
- 同 ID 并发访问共用一次装载；读列表不会装载 Agent / 正文。分页排序包含 ID，避免同时间戳遗漏。
- 释放策略下完成、取消和读操作之后可重新从 Store 装载；在途执行、确认、后台通知和订阅不能丢失；分支、导入、父子删除、配置引用检查保持正确。
- 使用延迟内存 Store 和真实 SQLite 测试；运行定向测试、`npm run test:runtime`、`npm run test:server`、`npm run check` 与 `git diff --check`。不使用收费模型，不构建或部署。

## 交付记录

- `packages/runtime/src/runtime-store.ts` / `runtime.ts`：移除全量启动接口，增加 `readSession` 和游标列表；复用串行准入合并同 ID 并发访问，命令队列排空后回收无引用的 Session。订阅异步装载，`waitForTurn` 固定读取引用，关闭先等待读取完成；父会话删除查询存储中的全部子会话，冷 Subagent 可按原 ID 继续。
- `packages/local/src/store.ts`：按 ID 及带过滤的游标读取；首次升级事务性回填 `needs_recovery` 并建立恢复、迁移和列表索引。后续启动只解析待迁移 / 待恢复记录，不保留全量数组；原 `sessions` 读取入口仅作为显式管理查询。`packages/local/src/runtime.ts` 分页汇总本地列表，`packages/server/src/server.ts` 保持原 HTTP `{ sessions }` 返回形状并适配异步 SSE 订阅。
- 新增 9 项回归，分布在 `packages/runtime/test/runtime.test.ts` 和 `packages/server/test/session-activation.test.ts`；同时迁移已有订阅及恢复替身。覆盖 600 个冷会话的零启动读取、两种策略的并发装载与订阅保护、240 个未装载子会话删除、260 条同时间戳分页、230 条本地 HTTP 列表、SQLite 恢复索引与关闭读取保护。显式 GC 额外核对 Agent、消息和 Session 配置引用回收。
- 验证通过：定向装载 / Runtime / SQLite 测试 26 项；`npm run test:runtime` 46 项；`npm run test:server` 191 项；模型 / 提示词 / 多模态四文件额外 12 项；`npm run check`、`git diff --check`。使用假模型和本地端点，无收费调用。首轮完整回归发现本地 HTTP 多出 `nextCursor`，已在传输层恢复原形状并补充断言，最终完整回归全部通过。
- 范围说明：本地统一按需读取元信息，但仍默认 `retain`；整 Session 回收仍显式选择。未引入 LRU、定时清理或另一套 Loop，也未为了形式分离再拆公共包。首次数据库升级仍需扫描旧元信息建索引；显式管理扫描、完整历史读取、单条大消息与超长 Turn 恢复尚不保证字节成本有界。
- 未完成：Cloud 五包三方增量同步、MySQL Store 新契约、工厂按目标会话恢复与助手配置解析、异步订阅及增量事件消费者迁移、归属 / 工具账本联合故障验收。本次未修改 Cloud / Amio，未提交、推送、构建或部署，未进行 Electron / Astron 产品实机验收。
