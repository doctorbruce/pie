# 当前对话的持久权限授权

状态：源码完成，未打包或部署

## 问题与目标

Astron 的 Pie 适配器把“允许一次”和“始终允许”都转换成 approved=true，后者没有记忆效果。用户确认“始终允许”应在当前对话内对同类操作跨回合生效，重启后保留。

## 范围与方案

- 交互回复增加可选 remember 布尔值；once 只结算当前请求，always 在保存授权成功后结算。
- 原生工具提供结构化 remember={permission, patterns}。Runtime 对可信请求生成的模式做严格字面匹配，不接受客户端指定授权模式；凭据、邮件和没有该能力的确认不展示或接受 always。
- 简单命令按可执行入口、子命令或脚本入口和工作目录归类；普通参数变化可复用。复杂 Shell 表达式保守地只记准确命令，不用字符串前缀放行拼接命令。
- 外部访问按操作、准确路径和命令类别保存，不把单文件授权扩大到整盘或所有外部目录。
- 授权归当前执行会话，单独写入 SavedSession.permissionGrants，不写入会被刷新覆盖的宿主权限配置。不传播到新对话、分叉或其他执行会话；重启时随会话元数据恢复。
- 不新增授权管理界面，不构建、部署或重启服务。

## 验收与测试决策

- T1：同类命令参数变化复用；不同子命令、脚本、目录、操作和复合命令不被越权放行。
- T2：once/always 的 HTTP/适配传递、跨 Turn 及重启恢复、会话隔离、保存失败不放行、不可记忆业务确认。
- 定向运行新增和受影响测试，执行 npm run check、适配器最低契约测试和 diff check。

## 实施记录

- 已贯通 Local 原生工具范围、Runtime 授权记忆和会话持久化、HTTP 回复以及 Astron Pie 适配器；只对支持记忆的原生权限展示“始终允许”。
- 同时修正默认权限下 PowerShell `&` 调用解释器时，将可执行文件误当作工作区外文件参数的问题。
- T1：`tools.test.ts` 12/12、`permission-scopes.test.ts` 2/2 通过，覆盖解释器调用、停止解析、命令类别和路径边界。
- T2：`runtime-permissions.test.ts` 4/4、`permission-memory.test.ts` 1/1、现有 `runtime.test.ts` 48/48 通过；HTTP 测试实际执行临时 Node 脚本并验证重启后的授权恢复。
- Astron 最小适配器契约集 `test_pie_transport.py`、`test_agent_core_contract.py`、`test_async_adapter_contract.py` 共 69 项通过；Ruff 检查通过。
- 提交前另从暂存区导出独立副本，排除其他未提交改动：Pie 完整检查及上述五个测试文件共 60 项通过，Astron 三个契约测试文件共 58 项通过；确认 workspace 包和 Agent 模块均从副本加载。
- Pie 完整 `npm run check`（Biome、TypeScript、模型数据校验）和两仓库 diff 检查通过。未调用真实模型；本次只提交源码，未构建、替换运行中的二进制或重启服务。
