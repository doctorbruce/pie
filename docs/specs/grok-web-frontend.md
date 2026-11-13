# Grok 风格 Web 前端

状态：已完成（2026-11-13，会话列表操作与日常交互细节复核）

## 问题与目标

Pie 已提供 HTTP/SSE 会话服务，但没有可直接使用的聊天入口。新增一个独立的本地 Web 前端，采用参考图中的两栏桌面聊天布局：左侧会话与助手列表，右侧消息流和底部输入栏。

## 范围

- 新增 `apps/web` 作为独立 Vite/React 工作区。
- 复用现有 HTTP/SSE 协议，支持会话列表、创建会话、流式消息、停止执行、模型与助手配置。
- 补齐日常使用所需的会话重命名/归档/删除、历史分页、分支切换、失败重试和运行中追加输入。
- 在 SSE 断线、版本缺口、服务重启和窄屏窗口下保持可恢复的状态与明确反馈。
- 默认视觉使用浅灰侧栏、白色消息区、蓝灰消息气泡、黑色 Bot 标识和圆角输入栏，适配窄屏。
- 不修改 Runtime、Local、Server 的会话语义；不新增后端代理协议或账号系统。

## 实现思路

最终形态选择本机 Web。现有 HTTP/SSE 已覆盖聊天、图片、工具确认和会话管理；浏览器能完成当前所需交互。通过 `npm run chat` 同进程管理 Core 与 Vite，减少两进程手工启动，不增加 Electron 的打包与升级依赖。本次不新增系统托盘、原生通知、自动更新或跨机器访问。

复用仓库曾有的前端运行时适配和消息转换代码，通过 Vite `/api` 代理访问本地 Core，避免浏览器直接跨 Origin。页面层重写为两栏布局：侧栏承载助手、搜索和会话列表，主区域承载会话标题、消息流、工具卡片和圆角输入栏，详情面板按需打开。

## 验收方式

- `npm run check`
- `npm run test:web`：消息转换、可靠 SSE、提交去重和真实宿主 HTTP/SSE / CLI 生命周期。
- `npm run test:web:browser`：本机 Chrome + 临时数据目录 + faux，覆盖完整操作及桌面/窄屏/小窗口。
- `npm run chat` 为日常入口；独立 `serve` / `web` 为开发入口。验收不调用付费模型。

## 实施记录

### 2026-11-13 会话操作与交互细节

- 问题：删除、重命名、归档藏在详情内，列表无法直接操作；搜索、模型入口和键盘反馈有遗漏。
- 范围与思路：每条会话增加可发现的操作菜单，支持不切换会话进行重命名、归档/恢复、删除；删除使用明确显示目标与不可撤销范围的确认弹窗，失败保留弹窗和原列表，运行中阻止不允许的操作。复用现有 API，不改后端会话语义。
- 同轮细节：清空搜索、当前模型入口、复制成功反馈、模型输入 Enter、详情面板的焦点与窄屏遮罩。保留已有功能，不增加依赖，不批量删除或修改用户数据。
- 实际改动：新增 `session-actions.tsx`，列表提供原生 Popover 菜单与重命名/删除 Dialog；`main.tsx` 复用现有 API 按目标 ID 更新列表，删除成功后才清理草稿，取消或失败保留原数据。`style.css` / `icons.tsx` 补操作入口、危险操作与复制反馈；`model-settings.tsx` 防止添加模型时 Enter 误提交设置。
- 验证：`npm run check` 通过；`node --conditions=source --test apps/web/test/session-title.test.ts packages/server/test/archive.test.ts` 6/6；`node --conditions=source --test --test-name-pattern='parent deletion discovers|child background job prevents deleting' packages/runtime/test/runtime.test.ts packages/server/test/background-jobs.test.ts` 2/2。
- 实际浏览器自检 15 项通过：不切换当前会话的重命名/归档/恢复；删除取消、409 错误保留、成功后的列表与首页状态；运行中禁用不允许的操作；复制、清空搜索、模型入口、模型输入 Enter；菜单底部定位及方向键/Escape；详情焦点循环与返回；420×780、320×480 无横向溢出。控制台错误/警告 0。
- 删除成功与拒绝响应在隔离临时数据代理中模拟，未实际删除用户或 fixture 的 Core 数据；真实后端删除保护由上述定向测试覆盖。自检记录与截图见同目录 `pie-session-ui-qa.json`、`pie-session-menu-desktop.jpg`、`pie-session-menu-mobile.jpg`、`pie-session-delete-dialog.jpg`（绝对目录见下一节）。未执行完整浏览器脚本、真实模型调用、构建、提交或推送；本次无已知阻塞项。

### 2026-11-13 参考图对齐

- 问题：此前验收偏重功能，界面仍像管理台；侧栏、气泡、字号与参考图有明显差距，首页不能直接输入，输入区状态和按钮拥挤。
- 本次范围：重做助手身份区、会话行、消息气泡、紧凑输入栏和统一 SVG 图标；首条消息直接创建会话，保留失败草稿；完善键盘焦点、窄屏、短窗口及减少动态效果偏好。
- 保留全部会话、模型、助手、插件、权限与恢复能力；沿用现有 HTTP/SSE，不增加依赖，不修改后端语义。
- 实际改动：`main.tsx` 重做首页、助手身份、会话行、消息气泡和状态层级；`icons.tsx` 统一 SVG；`composer.tsx` 支持首页直接发送、建议追加并保留附件、桌面聚焦和连续发送后的焦点恢复；`style.css` 统一间距、字号、胶囊输入、动效与响应式布局。设置/详情面板统一关闭按钮，会话模型目录优先显示已配置项。
- 检查中修复：首页首条创建成功即转移并清理首页草稿，避免失败重试后旧稿复活；建议追加文字而不覆盖已有输入或图片；输入恢复可用后再恢复发送焦点；窄屏关闭导航后不再残留侧栏阴影。
- 验证：`npm run check` 通过；`node --conditions=source --test apps/web/test/messages.test.ts apps/web/test/session-connection.test.ts apps/web/test/session-title.test.ts apps/web/test/turn-submission.test.ts` 28/28。
- 本轮实际 CUA：使用独立临时数据和本机假 HTTP 模型，验证首页首条仅创建一次会话、流式 Markdown/表格、图文首条、成功清稿、建议保留输入与附件、切换、新建、停止、分支重试、连续 Enter 发送焦点、设置关闭及模型分组。检查默认桌面、420×780、320×480，输入可见且无横向溢出；移动导航进入搜索并隔离背景焦点，控制台错误/警告为 0。
- 截图与自检记录：`C:/Users/benyo/.codex/visualizations/2026/11/13/01a1d386-8eac-7ec2-9bd9-afeb8f4c097c/`。未重复前序全部权限/断线恢复操作，未运行 `browser.mjs` 或 Windows CLI SIGTERM 测试；未构建、提交、推送或调用真实提供商。无本次已知阻塞项。

### 真实桌面 CUA 复核

- 使用独立 `PI_DATA_DIR`、Chrome profile 与 `DISPLAY=:5`，通过桌面鼠标、键盘和截图操作实际界面，不运行 `apps/web/test/browser.mjs` 代替验收。
- 实际通过：启动连接；创建/保存提供商、模型、助手与插件挂载；插件 `skill_search`；新建、搜索、切换、重命名、归档/取消归档；真实 HTTP/SSE 流式、停止、原 Turn 手动恢复、执行中追加；失败后编辑新分支重试；图片预览/发送与切换会话恢复草稿；工具批准/拒绝/记忆授权/确认框停止；刷新恢复文本草稿；关闭/重启宿主后自动重连；66 条历史的更早消息加载；桌面、窄窗口与短窗口操作。
- 界面发现并修复四项：`main.tsx` 接入 `remark-gfm` 渲染表格；工具确认展示工作目录，将完整授权范围放入可展开详情；`model-settings.tsx` 增加图片能力开关，Runtime 协议和 Local 模型目录投影有效 `input` 能力；`session-title.ts` 等待首次 Turn 结算后命名，失败保留首条标题、后续消息不覆盖，手动标题等待在途自动命名完成。
- 修复后再次实际点击回归：图文请求的本地假模型报告收到 1 张图片，表格正确显示，首条标题及手动标题刷新后保留，工具确认与小窗口可用。未发现剩余阻塞项。截图、操作记录及验收索引位于 `/workspace/codex-runs/pie-cua-artifacts/`。
- 最终验证：`npm run check` 通过（格式、根/Web/宿主类型、模型数据）；`npm run test:web` 32/32；`node --conditions=source --test packages/server/test/model-input-settings.test.ts packages/server/test/model-override.test.ts packages/server/test/provider-composer.test.ts` 5/5。新增标题测试 5 项和模型能力 HTTP 测试 2 项。仅 faux/本机假 HTTP 模型，无付费调用；未运行构建或本轮浏览器脚本。

### 2026-11-12 持续完善

- 第一阶段：新增 `apps/web/host.ts` 与共享 Vite 配置，提供 `npm run chat`；随机 Core 端口和令牌由本机代理管理，Host/Origin 校验后再代理。退出前等待 Core 清理和持久化，开发仍支持独立 `serve` / `web`。
- 验证：宿主 HTTP/SSE、异源拒绝、启动失败释放、真实 CLI SIGTERM 与重启取消状态共 4 项通过；宿主单独 Node 类型检查纳入根 `check`，`npm run check` 已通过。未运行构建或付费模型。
- 第二阶段：`main.tsx`、`composer.tsx`、`session-connection.ts`、`turn-submission.ts` 补齐会话搜索/标题/归档/删除/导出、历史分页/分支、图片与草稿、复制、执行中追加输入/停止/恢复、权限确认及记忆；设置面板补加载重试/参数校验/助手删除，会话详情提供模型、工作目录和后台作业。
- 验证：`npm run test:web` 27/27；`npm run check` 通过。多轮 Chrome 回归发现并修复窄屏高度、同会话分支重连、过期请求、停止弹窗和失败草稿等问题。

- 第三阶段：将 Chrome 回归保留为 `apps/web/test/browser.mjs`，无新增依赖；修正短窗口网格高度、隐藏侧栏键盘焦点及其他分支图片草稿恢复。
- 最终浏览器验收 20/20，383 个 SSE 包，运行时/控制台错误 0。覆盖首次连接失败自动恢复、真实崩溃 fixture 的原 Turn 手动恢复、流式/图片、发送失败保留草稿、工具批准/拒绝/停止、执行中追加要求、独立分支重试、64 条历史分页、标题/归档/搜索、提供商/助手保存、插件导入卸载、断线恢复、其他分支图片重发、键盘焦点与刷新。人工复核 1440×960、420×780、320×480、900×500 截图，输入栏和侧栏独立滚动正常。最终检查与 27 项定向测试通过，无本次未完成的验收项。

## 边界与剩余风险

- 前序实现扩展 Runtime 模型目录的可选 `input` 字段与 Local 有效能力投影，并增加 Server HTTP 测试；本轮视觉重做仅修改 Web 前端，没有更改会话/Turn 语义。未重跑全部后端测试。11 月 11 日记录的后台作业/Worker/PowerShell 全量失败不在本次修复范围，不宣称已修复。
- 修改已有模型的能力/参数后，已加载的会话需重启聊天服务使用新配置；新会话立即使用。设置保存反馈已说明这一点。
- Web 入口使用本机 Vite 服务，尚无桌面安装包、托盘或自动更新；本次未执行构建/Sidecar 打包或部署。
- 已验证 Chromium；其他浏览器、Windows/macOS 原生窗口与真实提供商凭据/网络尚未实测。文本草稿保存在浏览器，图片草稿只在当前页面内存中保留；已发送历史由 Core 持久化。
