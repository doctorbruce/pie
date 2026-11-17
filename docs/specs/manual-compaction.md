# 原生手动上下文压缩

状态：已完成（源码验收）。更新日期：2026-11-17。

## 问题与目标

Pie 已支持请求前与超限恢复时的自动压缩，但宿主的手动 `/compact` 没有原生入口。提供独立的 Runtime 和 HTTP 操作，复用同一摘要、切分、checkpoint 和事件流程，不通过普通 Turn 或伪造消息触发。

## 范围与方案

- `compactSession(id, { model? }, { signal? })` 与 `POST /sessions/:id/compact` 等待完成后返回 `{ completed: true, compacted, compaction? }`。`model` 使用 `{ provider, id }`；省略时复用会话选择，显式选择仅用于本次摘要，不改写模型 override。
- 手动请求使用 `manual` 原因，独立于自动压缩开关；复用最近 token 窗口与工具安全切点，另保留最近真实用户输入及图片。空历史、没有安全切点或仅剩保留区、没有新的可压缩历史返回 `compacted: false`，不调用模型。
- 拒绝运行、准备和其他写入中的会话；模型请求不阻塞 Runtime 控制队列。取消、连接断开、服务关闭和错误均回收操作状态；checkpoint 提交前取消不得裁剪，提交失败保留原工作窗口。
- 先可靠保存 checkpoint 与原文，再替换工作窗口；完整历史、导出和重启恢复不变。复用 `compaction.started/retry/updated/finished`，重试保留原因，完成事件携带本次 checkpoint 并在 HTTP 成功响应前发布。
- 不修改真实会话，不构建、部署、重启或提交；不增加依赖、另一套摘要流程或 UI。

## 验收与测试决策

- T1：纯压缩变换验证手动绕过阈值/自动关闭、无可压缩内容、单轮长工具历史可压缩、保留最近真实用户/图片/工具配对及原文。
- T2：本地模拟 Provider + Runtime/HTTP 契约验证成功与事件、模型选择、重复/no-op、busy、失败、取消与关闭后可继续操作；不使用真实模型或凭据。
- 定向压缩回归、`npm run check`、`git diff --check`。

## 实施与验证结果

- Runtime/Agent/compaction/protocol 提供独立操作，本地宿主与 HTTP 直接转发；模型等待不占控制队列。同会话写入口在入队和执行时检查归属，checkpoint 提交前再查取消，已开始的保存事务等待完成。
- Worker 等待压缩结束后接纳输入；独立 `session_compacting` 拒绝原因避免忙循环和把上次失败 Turn 误记成本次投递失败。checkpoint 同时保留历史发现的原生及 MCP 工具名称，手动摘要不连接 MCP；下一次正常 MCP 准备按实际允许的工具恢复 schema。
- README、嵌入说明、压缩专题与 Runtime/Server changelog 已同步。独立审核发现的 Worker 等待、旧 Turn 竞态及工具名单丢失已修复并补回归，复核无剩余阻断。
- 以下最终定向回归 **61/61 通过**，均使用 faux provider 或本地 HTTP fixture：

```sh
node --conditions=source --test packages/runtime/test/manual-compaction.test.ts packages/runtime/test/manual-compaction-tools.test.ts packages/server/test/auto-compaction.test.ts packages/server/test/auto-compaction-server.test.ts packages/server/test/compaction.test.ts packages/server/test/compaction-server.test.ts packages/server/test/manual-compaction-server.test.ts packages/server/test/working-history.test.ts
```

- 最终 `npm run check` 通过：Biome 检查 518 文件、根及 Web/host TypeScript、生成模型数据检查均通过；`git diff --check` 通过。
- 额外运行既有 `tool-search.test.ts`：3/4 通过，首条 HTTP fixture 的工具列表缺少当前并行通信改动已加入的 `communicate`。仅在临时 preload 中还原本次工具保留改动后，原断言仍同样失败；未修改该 fixture。相同 preload 下新增工具保留测试的两个场景均失败，当前实现均通过；临时文件已删除。
- 未调用真实模型、修改真实会话或运行构建/部署/重启/提交。未运行付费 Provider 套件；working-history 回归验证引用替换，未启用 `--expose-gc` 的 GC 断言。

### 2026-11-17 提交前联合验收

- 用户将提交范围扩展为 Pie 当前全部改动后，修正 `tool-search.test.ts` 五处默认工具列表，纳入统一根会话的 `communicate`；该文件 **4/4 通过**。上面的 3/4 结果仅记录此前隔离手动压缩改动时的历史，不再是当前未解决项。
- 当前真实工作区全部已修改/新增 Runtime、Server 测试及 Worker 核心补充共 **30 文件、331/331 通过**，无失败或跳过；命令与选择范围见 `super-agent-coordination.md` 同日验收记录。不与前次 61 项重复累加。
- 完整 `npm run check` 再次通过（Biome 518 文件、根/Web/host TypeScript、模型数据检查）；独立审核无剩余阻断。仍未进行真实模型、桌面人工、构建、部署或重启验收。
