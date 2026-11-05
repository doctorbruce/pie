# 会话归档

状态：已完成；提交前复验 `npm run check` 及原生归档 HTTP 测试通过。

## 目标与范围

补齐 Pie 原生会话归档及 Astron Core 适配；归档保留历史，不删除会话、不取消任务、不修改前端。

## 实现

- 会话 payload 保存可选 `archived`，历史记录缺省视为 false。
- `POST /sessions/:id/archive` 接受 `{ archived: boolean }` 并返回会话快照；子会话只读。
- 公开会话列表默认隐藏归档，`includeArchived: true` 包含全部；存储层在分页前过滤，内部无过滤查询保留原语义。
- Astron Pie adapter 声明 `session.archive`，经原生接口写入；查询包含归档后按 Core 查询契约过滤。
- 归档为展示状态，运行中也能修改；不影响任务生命周期。

## 验收

用本地 HTTP/SQLite 集成测试验证归档、取消归档、重启保持、历史保留、错误输入及分页；适配器契约测试覆盖归档往返和列表过滤。运行 Pie `npm run check` 及 Astron 必需契约检查，不打包部署。

## 实际结果

提交前复验：工作区其它在途类型错误已修复，`npm run check` 全部通过，`node --conditions=source --test packages/server/test/archive.test.ts` 通过。下述阻塞记录为实现阶段历史结果。

- Pie：`protocol.ts` / `runtime.ts` / `runtime-store.ts` 定义归档状态、写入与列表过滤契约；`local/src/store.ts` 在分页前过滤，`local/src/runtime.ts` 暴露方法，`server.ts` 暴露 HTTP。服务 README 和 runtime CHANGELOG 已更新。
- Astron：`adapters/pie/core.py` 声明并执行归档，`transport.py` 调用原生接口并读取完整列表；`docs/pie-tools.md` 记录需更新 sidecar。
- `node --conditions=source --test packages/server/test/archive.test.ts packages/runtime/test/runtime.test.ts`：50 项通过；随后新增失败写入/子会话只读测试，`--test-name-pattern=archive` 定向 3 项通过。
- Astron 归档、Pie Core、Agent Core、async adapter 契约：62 项通过。复用 Engine site-packages 与可用 Python 3.13，未同步依赖。
- 定向 Biome、Ruff 和 `npm run check:model-data` 通过。
- `npm run check` 的 Biome 阶段通过；末次 TypeScript 被其它在途后台作业测试 `background-jobs.test.ts:57` 的参数类型错误阻塞。此前 `runtime.ts` 的 `waitingReads.add/delete` Promise 类型错误已随并行工作消失；未改动这些逻辑。
- 扩展 `test_pie_transport.py` 套件收集受现有 Python 环境缺少 `rpds.rpds` 阻塞，未将其计为通过。
- 未打包、替换 sidecar 或执行 Electron 手工验收；未提交。无功能范围偏差。
