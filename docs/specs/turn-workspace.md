# 宿主更新已有会话执行目录

状态：已完成，收缩为独立接口并通过定向验证。日期：2026-11-12。

宿主更改默认工作区并复制文件后，已有 Pie 会话仍保存原工作区；仅更新产品绑定会使下一轮工具继续使用旧目录。

工作区的默认根、目录结构、文件复制和产品绑定迁移归宿主所有。Pie 只保存宿主提供的会话执行目录，供工具上下文使用；Agent loop 不感知产品工作区。普通 `submitTurn` / `POST /sessions/:id/turns` 不接收目录修改参数。

只通过 `setSessionWorkspace` / `PUT /sessions/:id/workspace` 更新已有会话的执行目录：先独立保存，再清除空闲 Agent，使后续普通 Turn 和 Worker 收件执行读取新目录。它不启动轮次、不替换历史，返回轻量 SessionSummary。相同路径幂等返回，不修改更新时间或 Agent，运行中也可核对；不同路径仅允许空闲根会话，运行、取消清理、中断、排队输入、后台任务和待答交互返回 409。保存失败恢复内存目录；存储故障仍要求重启核对和重试。不增加存储格式、数据库修复或文件迁移行为。

验收使用本地假模型和 SQLite：实际工具在新目录产生文件、历史与重启后的绑定保留；同目录复用 Agent；运行中不同路径拒绝、同路径幂等；无效目录和写入失败不切换。HTTP 集成验证保存后立即重启，再由 Worker 收件自主执行到新目录。运行定向测试与 `npm run check`，不构建、部署或调用真实模型。

实际改动位于 Runtime、Local 和 Server 入口，回归收敛到 `packages/runtime/test/session-workspace.test.ts` 与 `packages/server/test/session-workspace.test.ts`；HTTP 协议和开发文档已同步。移除原先的 Turn 参数及其准入分支，HTTP 回归先复现普通 Turn 意外切换目录，再通过收缩实现修复。

测试决策：T2，保护宿主更新执行目录后，普通 Turn 和 Worker 的实际工具目录、持久绑定及历史不丢失。运行 `node --conditions=source --test packages/runtime/test/session-workspace.test.ts packages/server/test/session-workspace.test.ts packages/runtime/test/workspace-owner.test.ts packages/server/test/session-creation.test.ts`，四项专项及既有 junction、Session 创建回归共 11 项通过；`npm run check` 的 493 文件 Biome、根及 Web 类型检查和模型数据校验通过。

文件复制及产品绑定事务由宿主负责；此接口只在调用时检查空闲，不锁住宿主复制期间的执行。未构建、部署或进行 Astron 桌面验证。
