# 后台工作观察

状态：已完成（2026-11-01）。

## 问题与目标

`waitForTurn` 和 SSE `turn.settled` 只表示一次 Turn 已完成结算；脱离前台的 Shell 或 Subagent 仍可继续，稍后的完成通知还能启动新的 Turn。宿主不能据此显示整个工作已结束。

## 范围与方案

- 增加 SDK `listBackgroundJobs(sessionId)` 和 HTTP `GET /sessions/:id/jobs`，返回 `instanceId / sessionId / jobs`。只读取会话元信息和本实例内存作业表，不加载消息历史。
- 作业只返回白名单元信息（身份、直接拥有者、类型、标题、状态、起止时间及错误），标题最多 512 字符、错误最多 2048 字符；不返回输出正文或任意 `details`。标题可能来自命令，摘要不是脱敏边界。
- 这是直接拥有的本实例作业观察，不是历史账本、持久外部任务查询、后代树汇总或未来完成承诺；进程变化须重新观察。现有 `waitForTurn` 与调度行为不变。
- 父会话删除同时检查子会话的活跃作业，防止删除已结束 Turn 的子会话后遗留后台执行。
- 不增加 wait-everything、递归 agent、状态机或持久队列；不涉及 Web、Astron/Cloud。

## 验收

使用门闩控制的本地作业和 faux 模型，验证 Turn 结束但作业仍运行、取消 Turn 不停止已脱离的作业、会话隔离、摘要不读正文、子作业阻止删除，以及 HTTP/SDK 和重启实例边界。执行相关 Node 回归、`npm run check`，不调用付费模型。

## 实施记录

- `packages/runtime/src/jobs.ts` 增加白名单摘要与返回类型，`runtime.ts` 增加只读查询并收紧子作业删除检查；根 SDK 导出类型。`packages/local/src/runtime.ts` 透传，`packages/server/src/server.ts` 映射 HTTP。
- `packages/server/test/background-jobs.test.ts` 四项通过：长文本摘要保留完整原记录、SDK/存储读取成本与会话隔离、子作业阻止父删除、真实本地 Shell 的 HTTP/SDK 一致性及重启边界。元信息观察不调用 `readPath/readWorkingPath/readHistory/readTree`；无真实模型调用。
- TDD 先复现缺少 SDK 方法、HTTP 404、子作业未阻止删除，以及摘要长文本无上限，再实现并通过。验证命令：`node --conditions=source --test packages/server/test/background-jobs.test.ts`，4/4；所涉五文件 Biome 与 `git diff --check` 通过。整仓检查及完整 Runtime/Server 回归由本次 harness 升级统一记录。
- 无新增调度或等待保证；近期终态按现有内存保留策略观察，标题/错误只是截断展示而非脱敏。行动日志：`/tmp/pie-background-jobs-log.md`。
