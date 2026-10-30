# 移除自带 Web UI

状态：已完成（2026-10-30）。

## 问题与目标

自带 Web 仅用于早期测试，不再是 Pie 产品的一部分。移除其代码和工程入口，避免继续以 UI 完整度评价执行内核；验收以 SDK、HTTP/SSE 和嵌入契约为准。

## 范围

- 删除 `apps/web`、专属测试和前端依赖，清理 workspace、启动和检查脚本及锁文件。
- 清理开发、接入和 SPEC 文档中的过时入口，更新 Server changelog。
- 去掉开发前端的默认 Origin，改为宿主显式设置 `PI_SERVER_ORIGIN`；无 Origin 的 SDK/HTTP 调用保持不变。
- 保留 Runtime、Local、Server、SDK 和 HTTP/SSE，以及共享事件合并和分页能力；独立提示词调试工具不在删除范围。
- 不修改测试发现规则、过时测试契约、Astron 或 Cloud。

## 实现与验收

先移除 UI 和工程依赖，再核对宿主入口与文档。Origin 行为通过本地 HTTP/SSE 回归验证；执行 `npm run check` 和现有相关测试脚本，扫描失效引用并检查 diff。只使用 faux 或本地 fixture，不调用付费模型，不构建、提交或推送。

## 实施记录

- 已确认 main 工作树初始干净；行动日志记录于 `/tmp/pie-remove-web-action-log.md`。
- 删除 `apps/web` 全部 13 个文件；根 `package.json` 移除 Web workspace、启动脚本、类型检查和专属测试参数，`biome.json` 移除对应文件匹配项。测试清单的发现方式不变。
- 刷新并安装锁文件：移除 177 个锁文件条目，无新增条目或保留依赖版本变化。保留 Vitest 所需的传递 Vite 依赖。
- `packages/server/src/server.ts` 移除旧前端开发 Origin 默认值，使用显式 `PI_SERVER_ORIGIN`；新增 `packages/server/test/global-stream.test.ts` 回归，验证认证、Origin、HTTP 创建会话及会话流/全局流的执行快照。
- README、开发/嵌入/MCP 文档、Server README/changelog、相关 SPEC 与历史报告均清理 UI 操作和失效路径。Runtime/Local/SDK、HTTP/SSE、共享合并与分页能力、独立提示词调试工具保留。
- 验证通过：新增 Origin 回归先复现 2 项失败，再通过 2/2；`npm run check` 通过（Biome、TypeScript、模型数据）；`npm run test:runtime` 62/62；`npm run test:server` 271/271（含新增回归及提示词调试工具测试）。
- 失效引用扫描仅保留本 SPEC 的删除范围、changelog 的旧配置迁移说明和回归中的拒绝样例。未改测试发现规则或旧测试契约；未构建、提交、推送，未实现 Astron/Cloud。无未完成项。
