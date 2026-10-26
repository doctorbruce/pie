# 流式响应中的工具提前执行

状态：已完成

## 问题与目标

当前 Agent 等整条模型响应结束后才启动工具。允许已明确结束且参数完整的调用提前执行，与剩余模型输出重叠；下一次模型请求仍等待本批结果。

## 范围与边界

- 只根据 `toolcall_end` 和可严格解析的原始参数确认调用，不根据参数片段或修补后的 JSON 提前执行。
- 提供商缺少原始参数增量或完整调用结束事件时，保守回退到响应结束后的原有批次执行。
- 保留权限确认、执行前持久化、结果按调用顺序提交以及下一轮等待屏障。
- 保留现有整批串行规则：流尚未结束时工具逐个提前执行；响应结束后按完整批次决定是否并行。
- 已确认完整的调用不因后续响应截断而撤销；不完整调用不执行。模型错误或取消后不再启动新调用，已启动调用必须收束。
- 不引入新依赖、工具中间输出回注、后台执行协议或构建部署。

## 实现思路

- Agent 流消费者记录原始参数和完整调用快照，提前调度，复用正常批次的执行结果，避免重复执行。
- 提前执行的前后钩子获得稳定的已完成前缀上下文；消息和调用块引用一致，保留工具重复提醒等历史检查。
- 提前启动事件携带完整调用快照；Runtime 在执行前保存到 Turn checkpoint，最终响应提交后清除。
- 响应尚未提交时进程中断，保留调用审计并拒绝盲目续跑；不新增流中断恢复能力。
- 现有后台 Shell、Subagent、外部任务以及 UI-only 进度语义不变。

## 验收

- 本地假模型与门控 Promise 验证：工具在响应结束前启动；下一次请求等待全部结果；不重放；结果排序稳定。
- 覆盖截断、修补参数、串行批次、取消、执行/落盘失败及持久化先于副作用。
- 运行修改的测试、最小相关 Agent/Runtime 回归及 `npm run check`，不调用真实模型。

## 进展

- Agent：`packages/agent/src/agent-loop.ts` 实现完整性确认、流中串行调度、批次结果复用、错误/取消收束；`types.ts` 为提前启动事件增加可选调用快照。下一次模型请求仍等待响应结束和本批结果。
- Runtime：`runtime-store.ts`、`runtime.ts` 在已有 started 账本写入中保存 pendingAssistant，最终 Assistant 提交时清除；runJob 可从已落盘快照读取调用。保留同工作树正在实现的 ToolExecution 账本。
- 恢复：`turn-recovery.ts` 在验证 Turn 输入路径后拒绝中途响应的盲目续跑；重启保留 started 审计，不伪造尚未提交的模型历史。
- 测试：新增 Agent 门控流测试、SQLite 持久化/失败隔离测试和真实子进程早期 checkpoint 崩溃测试。分页断言改为依据实际基线；崩溃 fixture 在 await 保存前克隆判定输入，避免共享消息数组被并发流更新后误判落盘边界。

## 验证结果

- `packages/agent` 下运行 `node ../../node_modules/vitest/dist/cli.js --run test/agent.test.ts test/agent-loop.test.ts test/message-replacement.test.ts test/streamed-tool-execution.test.ts`：58 项通过。
- `npm run test:runtime`：54 项通过，包含工具重复提醒、分页、前后台子任务和恢复回归。
- `node --conditions=source --test packages/server/test/turn-recovery.test.ts packages/server/test/streamed-tool-execution.test.ts`：16 项通过，包含实际进程退出与 SQLite 重开。
- 附加定向运行 durable-jobs、tool-execution、external-tools、tool-progress 与 Web messages：35 项通过；同轮暴露的恢复旧断言/fixture 边界问题已修复并以上述 16 项复验。
- `npm run check`：通过，格式、根目录/Web 类型检查和生成模型数据均通过。
- 无范围偏差；未新增依赖、调用真实模型、构建、部署或提交。真实提供商是否有可重叠的逐调用结束事件，仍由其适配器能力决定，不保证每种协议都有同等延迟收益。
