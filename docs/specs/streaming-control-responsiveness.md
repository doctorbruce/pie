# 流式输出与控制面响应

状态：已完成。更新日期：2026-10-15。

## 问题与范围

Astron 使用全局 `/events` 接收增量事件，但每个逐字事件仍读取、解码和复制整份持久历史；现场会话快照约 9.4 MB，取消请求超时后旧回合继续执行，新会话操作也受到影响。

仅优化全局事件发布：不为全局订阅重建完整历史，保留实例、版本、回合和增量事件。单会话完整快照、历史导出、分支和存储语义保持不变；不裁剪历史，不增加依赖，不调整模型重试策略。

## 验收

- 全局流式事件不触发完整历史读取；取消后可创建新会话并完成下一轮。
- 单会话 SSE 仍包含完整历史，全局 SSE 既有协议和跨订阅隔离不变。
- 运行定向回归、现有 runtime/server 测试和类型检查；记录实际结果与未验证项。

## 交付与验证

- `runtime.ts` 仅在有单会话订阅者时读取完整快照；全局订阅只克隆事件与实例、版本、回合元数据。`protocol.ts` 区分两类事件，`server.ts` 保持现有全局 SSE 线上格式。回归已接入 `npm run test:server`。
- 新回归修复前在首个增量事件发现额外历史读取（6 次而非基线 1 次），修复后通过；覆盖图片历史、取消、旧会话继续、新会话完成、订阅隔离和单会话完整快照。
- `node --conditions=source --test packages/server/test/global-stream.test.ts packages/server/test/runtime.test.ts packages/server/test/server.test.ts packages/server/test/working-history.test.ts`：25 项通过。
- 在 HEAD 加本次补丁的隔离目录补齐既有生成模型数据后，`npm run check` 通过；没有对原工作树运行全仓自动格式化，也没有打包既有未提交的 shell/job 改动。
- Windows Bun EXE 对照使用本地模拟模型、约 19.6 MB 历史和 1000 条突发增量：旧版取消超过 5 秒超时，修复版约 4 毫秒完成取消，后续新会话完成且完整历史保留；未调用付费模型。
- 已备份旧 EXE 并更新 Pie 产物、Cowork 资源和用户侧安装，三份 SHA256 一致。产品 HTTP 新建、详情和清理诊断会话通过；原会话为 cancelled，历史详情正常。未直接点击验证 Electron 界面。
- 测试决策：T1 + T2；风险是逐字事件拖慢共享控制面，以及精简事件破坏历史/订阅契约。采用真实 SQLite 与公开 runtime 行为回归、现有 SSE 契约和编译 EXE 对照，不新增端到端框架。
