# 测试发现与契约回归

状态：已完成（2026-10-30）。

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
