# 宿主压缩阈值

状态：源码与验证已完成；未部署。

## 问题与范围

Astron 的压缩阈值保存在应用根 `settings.json` 的当前账号配置中，但没有传给 Pie。该文件是唯一用户配置来源，不在 Pie 数据目录另存配置副本。只补宿主运行参数，不改变压缩算法、重试策略或独立运行模式的文件配置。

## 实现

- `AgentRuntimeConfig.compaction.thresholdTokens` 接收宿主从公共设置读取的阈值；空对象使用模型预算默认值。
- 宿主压缩参数不读取 Local 的 `settings.json`；无宿主参数时沿用独立运行配置。
- 阈值参与宿主 runtime revision，刷新后从下一 Turn 生效；Subagent 使用自身宿主配置，在途 Turn 不受影响。
- 沿用模型上下文窗口的安全上限，拒绝非法阈值。

## 验收

- Astron 契约测试验证 200K、120K、清空和 revision 变化，且不生成第二份设置文件。
- Pie 本地模型端点测试验证宿主高阈值不压缩、热更新低阈值后同会话压缩、清空恢复默认、原生设置文件不被读取。
- 定向压缩/宿主配置回归及 `npm run check`。不调用真实模型，不修改用户运行进程。

## 结果

- 测试决策：T2；通过宿主配置契约与本地模型端点集成测试，防止阈值热更新失效、重置失效或误读第二份配置。
- Astron：`engine/.venv/Scripts/python.exe -m pytest` 定向执行 Pie transport/Core/MCP、用户路径迁移、生命周期、诊断导出与 Core/async adapter 契约测试，107 项通过、2 项跨仓工具测试未启用；Ruff lint/format 与 diff check 通过。
- Pie：当前工作区 `npm run check` 全部通过；`node --conditions=source --test packages/runtime/test/host-compaction.test.ts packages/runtime/test/runtime.test.ts packages/server/test/auto-compaction-server.test.ts packages/server/test/auto-compaction.test.ts packages/server/test/compaction-server.test.ts` 共 38 项通过。全部使用本地模型端点或 faux。
- 尚未打包或部署新的 Sidecar，未重启用户的 Agent/Pie；真实桌面界面端到端验证待更新可执行文件后进行。
