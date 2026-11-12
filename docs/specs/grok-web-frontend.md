# Grok 风格 Web 前端

状态：已完成（2026-11-11）

## 问题与目标

Pie 已提供 HTTP/SSE 会话服务，但没有可直接使用的聊天入口。新增一个独立的本地 Web 前端，采用参考图中的两栏桌面聊天布局：左侧会话与助手列表，右侧消息流和底部输入栏。

## 范围

- 新增 `apps/web` 作为独立 Vite/React 工作区。
- 复用现有 HTTP/SSE 协议，支持会话列表、创建会话、流式消息、停止执行、模型与助手配置。
- 默认视觉使用浅灰侧栏、白色消息区、圆角输入栏和蓝色 Pie 标识，适配窄屏。
- 不修改 Runtime、Local、Server 的会话语义；不新增后端代理协议或账号系统。

## 实现思路

复用仓库曾有的前端运行时适配和消息转换代码，通过 Vite `/api` 代理访问本地 Core，避免浏览器直接跨 Origin。页面层重写为两栏布局：侧栏承载助手、搜索和会话列表，主区域承载会话标题、消息流、工具卡片和圆角输入栏，详情面板按需打开。

## 验收方式

- `npm run check`
- `node --conditions=source --test apps/web/test/messages.test.ts`
- `npm run web` 后在浏览器确认页面可加载、可读取会话列表并显示 SSE 更新；真实模型调用只在用户配置凭据后进行。

## 实施记录

- 新增 `apps/web` React/Vite 工作区，恢复 HTTP/SSE 适配、消息转换、设置面板和回归测试。
- 重写 `apps/web/client/main.tsx` 和 `apps/web/client/style.css`，实现参考图风格的浅色两栏聊天界面，并保留模型、助手、插件、停止、恢复和交互确认入口。
- 根 `package.json`、`biome.json` 和锁文件重新纳入 Web 工作区；README、开发文档和原删除 SPEC 已同步更新。
- 验证通过：前端变更完成后 `npm run check`；`npx biome check --error-on-warnings apps/web`；`npx tsc --noEmit -p apps/web`；`node --conditions=source --test apps/web/test/messages.test.ts`（5/5）。启动 `npm run serve -- --port 4318` 与 `npm run web` 后浏览器页面加载、真实会话列表和历史消息展示正常，设置弹窗可打开，控制台无错误。
- 最后一次仓库级 `npm run check` 被并发 WIP 修改的 `packages/agent/src/agent-loop.ts` 格式检查拦截；该文件及相关 Runtime 测试改动未由本前端任务触碰，已保留。
- 完整 `npm run test:server` 共 587 项，579 项通过；2 项失败、6 项取消，均为现有后台作业/Worker/权限/PowerShell 测试的超时或平台行为，未涉及前端文件。
