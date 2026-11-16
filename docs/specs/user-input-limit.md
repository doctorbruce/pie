# 用户输入长度上限

状态：已完成。

## 问题与目标

Pie 原先把单条 Turn 用户文本限制为 16,000 字符，低于支持大上下文模型的实际能力。将用户 Turn 文本上限提高到 1,048,576，沿用 JavaScript `String.length` 和 HTML `maxLength` 的 UTF-16 计数方式，保留请求体、图片和模型上下文预算边界；此数值不是 token 上限。

## 范围

- 修改 `text` 的 Runtime/API 校验和 Web Composer 上限。
- 保留 `displayText`、systemPrompt、协调消息和插件配置等独立字段的现有限制。
- 不修改模型上下文窗口、自动压缩算法或 HTTP 请求体上限。

## 验收

- 16,001 字符的用户 Turn 可以进入正常受理流程。
- 超过 1,048,576 字符的用户 Turn 在调用模型前返回 400。
- 相关 Runtime/Server 测试及 `npm run check` 通过。

## 实际改动与验证

- `packages/runtime/src/protocol.ts` 导出共享上限；`runtime.ts` 的 Turn/steer 正文校验和 `apps/web/client/composer.tsx` 同步使用。
- `packages/server/README.md` 说明新上限；`packages/server/test/server.test.ts` 验证 16,001 字符受理、超过新上限返回 400。
- `node --conditions=source --test packages/server/test/server.test.ts`：17 项通过。
- `npm run check`：通过；`git diff --check`：通过。
- 未完成项：无。未构建、部署或调用真实模型；模型 token 容量不在本次范围。
- 注意：显式传入的 `displayText`、协调输入批次和 Worker 消息仍各限 16,000；长文本通过这些入口时仍会被拒绝。
