# 外部异步任务关联与结果接管

状态：已完成（PIE 侧契约与接管闭环；Cloud 执行器待接入）。更新日期：2026-10-26。

## 问题与目标

内存 `BackgroundJobs` 保存 Promise、输出和完成回调；实例退出后，新实例无法知道原异步任务是否仍在执行。会话可重建不等于任务可接管。

本次为共享 Runtime 增加外部任务能力：先持久化稳定任务关联，再提交给宿主执行器；新实例按原 ID 查询并补入已完成结果，再继续原 Turn，不重新提交任务。不是保存异步函数或从代码行断点续跑。这里的 Job 不是 PIE 的顶层领域对象，而是 `Turn` 下可跨进程接管的 `durable` `ToolExecution` 的宿主适配名称。

## 范围与不做

- 宿主注入 `DurableJobExecutor`，负责 `durable` `ToolExecution` 的幂等提交、持久状态/结果查询和取消请求；PIE 不实现 Redis、云端 Worker、租约或工具内部 checkpoint。
- 工具通过可选的 `context.runJob(toolCallId, signal)` 使用宿主执行器；关联保存在原 Turn checkpoint，与会话存储共用提交屏障。
- 正常执行等待外部结果；进程关闭或查询失败时保留可恢复 Turn，不把未知结果伪造成普通失败结果。新实例恢复先查询旧任务，全部结果明确且提交成功后才启动模型。
- running、missing、unknown 或身份不匹配时拒绝推进；已提交结果不重复补写；不重放 `submit`。取消先保存意图，再请求执行器取消，不承诺外部副作用已撤销。
- 本地内存 Job、Shell、Subagent 保持原实现和默认行为；不宣称它们自动变成可迁移任务。不新增 HTTP 任务平台或自动调度器。

统一执行账本及 `inline` / `delegated` / `durable` 执行模式见 [Turn 恢复 SPEC](turn-recovery.md)。本 SPEC 只约束外部执行器的关联、查询、结果校验和取消语义，不新增独立的 Job 恢复模型。

账本将稳定关联与 `submission_intent` 一起提交，执行器确认后记录 `submitted`，最终 `toolResult` 与工具终态账本一起提交。没有提交确认记录不能证明任务未执行；恢复仍只查询旧任务，不重新提交。账本在终态后保留，但不加入 Session 快照或 SSE；共享 Store 适配与验收以 Turn 恢复 SPEC 为准。

## 实现与验收

1. 共享任务契约、稳定关联和结果校验；工具上下文注入，Runtime 在提交前保存关联。
2. 扩展恢复判定，允许有有效任务关联的未完成工具调用；`resumeTurn` 查询原任务并原子补入结果/准入，保持原配置和 Turn 身份。
3. SQLite 显式恢复模式保留这些关联，不补写假的未知结果；关闭只解除等待，不因更新服务就取消外部任务。
4. 用真实 SQLite 和持久执行器替身验证实例重建、丢通知、重复恢复、错误/取消结果、查询/提交失败以及本地回归。运行最小测试、`npm run check`、Runtime / Server 完整回归；不调用真实模型或修改 Cloud。

## 完成记录

- `packages/runtime/src/durable-jobs.ts` 定义执行器、任务身份和结果校验；`tools.ts` / `agent.ts` 注入可选 `runJob`。结果保留文本、图片、结构化 details 与 usage，失败/取消按工具错误进入原 Loop，不传递动态注册或提前终止指令。
- `runtime.ts` 在 `submit` 前提交 `turnCheckpoint.jobs`；提交响应丢失、查询失败及关闭只停止本实例等待，不保存本地中止产生的假结果。恢复只查询缺失结果，全部结果与原 Turn 准入一起提交后才调用模型；保存失败不推进。等待自动关联 Turn 停止信号，即使工具未转发可选 signal 也能解除等待。
- `turn-recovery.ts` 与 `packages/local/src/store.ts` 在显式恢复模式下保留合法外部任务关联；默认本地恢复策略和内存 Shell/Subagent 不变。取消先保存意图再请求执行器，慢取消响应不能让模型继续；历史保留任务身份并标明最终副作用未知。
- 新增 Runtime 单测 3 项、SQLite/跨进程集成测试 16 项。真实子进程分别在关联提交后、任务提交后退出；新实例不依赖旧回调或通知，不重复提交。覆盖 running/missing/unknown/身份不符、已知失败和取消、提交响应丢失、查询/保存失败、并发恢复、两种保留策略、无执行器、取消意图及关闭边界。
- 验证：`npm run test:runtime` 51 项、`npm run test:server` 221 项通过；定向 `node --conditions=source --test packages/runtime/test/durable-jobs.test.ts packages/server/test/durable-jobs.test.ts` 19 项通过。`npm run check` 与 `git diff --check` 通过。仅使用持久执行器替身、SQLite 和本地假模型，未调用真实 Provider。
- 未完成与偏差：没有新增 Redis/MySQL/Worker 实现、分布式租约或通知系统；Cloud 同事须实现并注入执行器、授权/归属和失租隔离，再联合验收。原内存异步任务不会自动迁移，也不从异步函数内部某行续跑；缺失/未知任务仍需人工核对，不自动重提。未修改 Cloud/Amio，未构建、部署、提交或推送。
