# 测试发现与契约回归

状态：已完成（2026-11-01，验收边界补强；2026-10-30 的发现规则阶段已完成）。

## 问题与目标

根测试脚本手工列举文件，漏掉新增的 Runtime/Server 回归；同时会让过时的 HTTP 契约长期不被发现。目标是自动覆盖 Core 相关测试，并保持测试只使用 faux 或本地 fixture，不扫描可能调用真实 Provider 的 AI 测试。

## 范围

- Runtime、Server 和提示词调试工具的 Node 测试发现。
- 修复 Session Transfer 的 Host Runtime 注册契约。
- 将只读 `check` 与 Biome 自动修复入口分开。
- 不修改 Web、运行时业务实现或真实 Provider 测试。

## 实现思路与验收

用 `scripts/run-node-tests.mjs` 递归发现指定测试目录中的 `*.test.*` 文件；根脚本只传入 Runtime、Server 和提示词调试目录，不扫描 `packages/ai/test`。Session Transfer 先注册 `/host-runtimes`，再按当前 `assistantId` 创建会话；`check` 改为只读，`check:fix` 保留 Biome 自动修复。

## 实施与验证

- 修改 `package.json`、`scripts/run-node-tests.mjs` 和 `packages/server/test/session-transfer.test.ts`；未修改 Web 或运行时业务代码。
- 定向漏测：18 项通过；其中 Session Transfer 修复了旧内联 runtime 导致的 `400 !== 201`。
- `npm run test:runtime`：自动发现 7 个文件，64 项通过。
- `npm run test:server`：自动发现 36 个文件，289 项通过；包含 Runtime、Server 和提示词调试测试，仅使用 faux/本地 fixture。
- `npm run check`：只读 Biome、TypeScript、模型数据校验通过；`git diff --check` 通过。
- 未运行真实 Provider、付费模型、构建或推送；无未完成项。

## 2026-11-01 验收边界补强

Harness 升级完整回归发现三个旧假设：SSE 结算包之后不会再发布 readiness revision、取消确认等于下一轮已经可准入、存储故障后的公开 revision 必须等于数据库 revision。保留自动发现与生产控制语义，改用已有的结算/准入/发布切面观察，并保留对历史和终态的断言；不以延时或放宽入口消除失败。

- `packages/server/test/server.test.ts`：保留 Turn 结算断言，等待后续可准入快照，再严格比较重连的 revision、execution 和历史。
- `packages/server/test/durable-jobs.test.ts`：用取消确认门闩代替固定延时；确认期间新提交返回 `409 cancellation_in_progress`，投影一致；`waitForTurn` 覆盖确认与结算后，再验证下一轮可提交。
- `packages/server/test/store.test.ts`：故障前捕获实际持久 metadata，故障后验证完整内容未变；另精确比较同 revision 的全局事件与 HTTP 投影，不把公开版本误当数据库最后保存版本。
- 首次完整回归：Runtime 73/73；Server 317 项中 314 通过、3 项暴露上述旧假设。三项均定向复现后修正断言，生产实现未因这些失败而放宽。
- 定向文件：Server/Durable Jobs 共 34/34，Store 19/19。最终 `npm run test:runtime` 73/73、`npm run test:server` 317/317，通过且无跳过；`npm run check` 与 `git diff --check` 通过。
- 本阶段无未完成项；未调用真实 Provider、付费模型，未执行构建或推送。
