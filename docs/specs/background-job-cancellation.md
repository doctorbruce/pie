# Turn 取消与本地后台作业

状态：已完成（2026-11-04）。

## 问题与目标

当前 Shell 后台化后移除工具取消监听，后台 Task 不关联父取消；用户停止当前 Turn 后，其命令和子助手仍可能继续执行。Pie 正常收尾不触发运行信号的 abort，无须沿用 Amio 对正常收尾信号的处理。

## 范围与方案

- 正常完成保留后台运行；显式取消运行中的 Turn 时，取消该 Turn 启动的 Shell、前后台 Task 及其子后台作业。
- 复用 Runtime 每次 Turn 独立的取消信号记录本实例作业归属，子作业继承祖先取消范围；不使用模型流的临时信号作为后台作业生命周期。
- 作业返回后台句柄后仍保留取消归属；停止时抑制相应完成通知，避免重新唤醒已停止的会话。取消结算等待关联本地作业收尾，再发布 Turn 终态。
- 其他 Session、先前已正常完成 Turn 的作业不受影响；旧 turnId 仍拒绝。已结束 Turn 的重复取消保持无操作，可用 `job_kill` 单独停止剩余作业。
- 不新增停止全部工作接口、常驻服务选项或持久任务恢复；外部 DurableJob 的取消与未知结果语义保持现状。不改 Agent Core，不构建或部署。

## 验收

使用脚本化本地模型和真实子进程验证：后台 Shell 在取消后退出；后台 Task 与子 Shell 一起停止；Task 已完成后遗留的子 Shell 仍按原父 Turn 取消；正常完成不停止作业；新一轮取消不影响旧作业，旧 turnId 不影响新一轮；取消通知不重新启动模型。执行最小相关 Runtime/Server 回归和完整 `npm run check`。

## 实施记录

- `packages/runtime/src/jobs.ts` 按 Turn 取消信号记录作业归属，提供静默取消与等待收尾；已取消范围迟到创建的作业从已取消状态开始。
- `packages/runtime/src/runtime.ts` 在显式取消、存储故障下的尽力停止及取消收尾中处理所属作业；子 Task 继承父范围，其 Shell 同时关联自身 Turn。`agent.ts`、`tools.ts` 与 `packages/local/src/tools/shell.ts` 传递并在异步等待前捕获归属，不修改 Agent Core。
- `packages/server/test/background-cancellation.test.ts` 新增 5 项集成回归，使用假模型、真实 SQLite 和真实命令进程；覆盖自动后台化、正常完成、旧 Turn 与其他会话隔离、前后台 Task 遗留 Shell、取消与子会话创建竞争及无额外模型唤醒。修复前 4 项均因作业仍 running 而失败，修复后全部通过；新增竞争测试确认取消后不会启动子模型或命令。
- 相关 Runtime/Server 10 个测试文件共 128 项通过：`node --expose-gc --conditions=source --test packages/server/test/background-cancellation.test.ts packages/server/test/background-jobs.test.ts packages/server/test/tools.test.ts packages/server/test/tool-progress.test.ts packages/server/test/local-cancellation.test.ts packages/server/test/execution-state.test.ts packages/server/test/canonical-identity.test.ts packages/runtime/test/runtime.test.ts packages/runtime/test/durable-jobs.test.ts packages/server/test/durable-jobs.test.ts`。
- `npm run check` 通过：Biome、TypeScript 和生成模型数据校验均通过。测试仅出现 Node SQLite 实验特性提示。
- 已同步开发、嵌入、HTTP 文档、后台观察 SPEC 和 Runtime Changelog。无方案偏差；未构建、部署或调用真实模型。实际进程退出已在 Windows 验证，其他平台未运行。
