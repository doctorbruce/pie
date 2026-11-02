# 普通模型请求重试

状态：已完成源码与本地回归验证；未构建或部署 Sidecar。

## 问题与目标

普通对话的模型请求遇到 `503 status code (no body)` 时直接结束 Turn；现有瞬时错误重试只用于压缩摘要。参考 Amio 默认执行链，让尚未产生输出的请求在有限退避后恢复。

## 范围与实现

- 普通请求复用现有错误分类、重试预算和可取消等待；默认最多重试 5 次，2 秒起指数退避，增加最多 25% 抖动，30 秒封顶，不按 Retry-After 调度。
- 尚未转发内容或工具事件且响应无有效内容时才允许重试。已输出的流不重放，既有工具结果沿用原上下文；上下文溢出仍由压缩链处理。
- SDK 重试关闭，避免和 Runtime 重试叠加。独立运行沿用 `settings.retry`，宿主有压缩配置时仍不读取本地配置文件。
- 不改 Turn 身份、持久化、HTTP/SSE 协议或工具恢复，不增加依赖；不构建、部署或重启 Sidecar。

## 验收

本地 HTTP + 真实 SDK 验证空正文 503 后恢复、耗尽预算、取消退避及工具结果不重复；行为单测验证输出边界、错误分类和退避上限。运行定向 Node 测试与完整 `npm run check`，不调用真实模型。

## 实施记录

- 已对照 Amio 的 `session/retry.ts` 与 `processor.ts`，并确认 Pie 普通请求未接通重试。
- `packages/runtime/src/model-retry.ts` 在模型流边界复用既有重试循环，`agent.ts` 接通普通请求；`compaction/retry.ts` 和 `compaction-settings.ts` 对齐默认预算、抖动与上限。
- `auto-compaction-server.test.ts` 在旧实现先复现空正文 503 直接失败、只请求一次、取消前已失败和工具后续无法完成；修复后 13 项 HTTP 契约回归全部通过，包括宿主 `compaction:{}` 不读本地设置。
- `node --conditions=source --test packages/runtime/test/model-retry.test.ts packages/server/test/auto-compaction.test.ts`：19 项通过；输出边界用例还验证终态错误丢失部分内容时仍不重放。
- `npm run check`：Biome、TypeScript 和模型数据校验全部通过；`git diff --check` 通过。
- 测试决策：T1 + T2。风险是多层重试、取消失效或工具重复执行；用流事件行为单测和本地 HTTP + 真实 SDK/SQLite 契约测试覆盖，无真实凭据和付费调用。不更改 HTTP/SSE 事件，普通重试期间保持原 Turn 运行状态；不增加重试状态展示。
