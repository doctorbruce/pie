# 工具日志与交付物元数据

状态：已完成（2026-11-11）

## 目标与范围

同步 Amio 的日志字段语义，避免宿主将原生工具的完整输出日志识别为交付物。仅修改 Local 的 bash、webfetch 和 job_output，以及直接相关回归。

## 方案

- bash 前台截断结果、后台结果与作业登记使用 `details.logPath`；job_output 从同一字段读取完整日志。
- webfetch 截断正文使用 `details.logPath`。
- 已有 `details.outputs[{ path, artifactRole }]` 继续声明交付物；不双写旧日志字段 `outputPath`，不增加宿主路径过滤。
- 保留日志内容、保留时间、后台增量读取和作业生命周期；不迁移历史工具结果，不修改 MCP 的 `details.mcp.fullOutputPath`。

## 验收

- 真实 bash 前台截断、后台完整日志与增量读取正常，日志字段不再暴露 `outputPath`，显式 outputs 保留。
- webfetch 截断结果的新字段指向可读完整正文，普通结果保持有界。
- 执行直接相关工具测试、`npm run check` 与独立审核；不构建、部署或修改 Cowork。

## 实施与验证

- 三个 Local 工具文件已同步字段和消费者，既有交付物声明及日志生命周期未变；更新原有回归、Server Changelog。
- 测试决策：字段变更跨越日志生产与后台读取，使用真实命令、真实日志文件和本地 HTTP 回归；无需模型调用或全量产品测试。
- 修复前 bash 前后台及 webfetch 回归因缺少 `logPath` 失败；修复后 `tools.test.ts` 12 项、`plugins.test.ts` 4 项、`webfetch.test.ts` 20 项全部通过。后台用例完整读回 7 万字节以上日志，并验证显式报告交付物保留。
- 本次六个 TypeScript 文件的 Biome 检查、模型数据校验及 `git diff --check` 通过；独立只读审核未发现问题。
- 全仓 `npm run check` 未通过：本次范围外的 `packages/runtime/src/agent.ts` 和 `packages/server/test/worker-sync-wait.test.ts` 存在格式问题；单独类型检查还发现同一 Worker 测试两处 `WorkerWaitResult.reason` 类型错误。保留其他会话改动，未代为修改。
- 无方案偏差；未提交、构建、部署或做桌面 UI 验证，历史日志元数据不迁移。
