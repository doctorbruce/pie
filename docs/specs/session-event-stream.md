# 会话增量事件与历史分页

状态：已完成。更新日期：2026-10-16。

## 问题与目标

存储已提供工作窗口和 seq 游标，但会话订阅在每个事件上调用完整快照。128 KiB 历史图片的复现中，14 个事件造成 14 次完整读取。每轮释放 Agent 不能解决执行过程中的读库、复制和发送放大。

## 范围与边界

- 共享 Runtime 的会话订阅改为 revision、Turn 和增量事件；正文仅随单条消息完成或初次快照发送，不在 token 事件中重复发送历史或完整 partial。
- 初次连接和重连使用最近 50 条的有界快照；HTTP 暴露现有 seq 游标分页，Web 使用增量并可加载更早历史。revision 是事件版本，seq 是历史节点游标，不能互换。
- 显式完整快照、导出、fork 和树读取仍可读取完整历史；GET 会话支持 limit，省略时保留其完整读取用途，避免改变 Astron 的 Pie 历史读取。
- Astron 使用的全局 /events 契约不变；不改 Astron 公共 AgentCore / ACP、Amio、存储格式、压缩或模型执行策略。不自动同步 Cloud，不提交或打包。

## 实现思路

- Runtime 在投递前生成轻量事件，不先计算快照再由宿主丢弃。首次快照的 revision 与订阅缓冲衔接，防止连接期间漏事件。
- 完成的消息保留原身份、图片和展示过滤；流式事件只带内容索引和增量。客户端按身份更新消息，忽略旧 revision；实例变化、事件缺口或历史切换时重新连接，加载最新一页。
- 分页校验 limit / beforeSeq / leafId，保留分支语义；Web 分叉使用稳定消息 ID，不使用分页后的数组下标。

## 接入方式

- 运行摘要见 [运行状态投影 SPEC](runtime-state-projection.md)：快照的 `execution` 必填，会话增量可通过顶层 execution 更新，全局事件的 snapshot 同样携带摘要；不能用它替代原始 `Turn.status` 或独立执行账本。
- HTTP 首屏：`GET /sessions/:id?limit=50`，limit 范围 1–200，返回 `history: { leafId, nextBeforeSeq }`；不传 limit 仍是显式完整读取。
- 旧页：`GET /sessions/:id/history?limit=50&beforeSeq=<seq>&leafId=<leafId>`，返回 `SessionHistoryPage`：实例、版本、叶子、带 id / parentId / seq 的节点和下一游标。leafId 固定为首屏返回值；null 表示空路径。游标用尽为 null，不能拿 revision 当 seq。
- 会话 SSE 先发最近 50 条的 snapshot；后续包在顶层带 instanceId / revision / turn，低频状态通过 state 更新，不再带完整 snapshot。message_update 不带 message / partial；message_end 只带当前完成的一条消息。类型名 snapshot 也可仅表示元信息变化，不保证有 snapshot 字段。
- 嵌入宿主先 subscribe 并缓冲，再 getSession(id, { limit: 50 })；丢弃版本不高于首屏的缓冲事件，用 `@pie/runtime/session-events` 的 applySessionEvent 顺序合并。返回 undefined 表示实例变化、版本缺口或 history.reset，须重新建立首屏与订阅；不提供服务端事件重放。
- Web 的旧页通过 prependHistoryPage(current, page, beforeSeq) 合并，不覆盖同时到达的新消息；实例、叶子或当前游标变化时丢弃旧请求，防止重连期间跳过中间页；分页和重连保留稳定消息身份，fork 传 beforeMessageId 而非当前页的数组下标。

## 验收

- 长历史、图片、工具、取消和 Subagent 下，会话 token / 结算事件不调用 readPath，也不携带完整历史或完整 partial。
- 分页首屏和旧页可重建历史；重连、重复事件、事件缺口、分支切换不丢失或重复消息；展示不泄露内部通知。
- 全局事件的定向回归保持通过，运行新增或修改的具体测试及 npm run check；不调用付费模型。

## 实施记录

- 延续 history-storage、compaction-working-history 和 idle-session-release 的后续边界，不重做存储适配或 Agent Loop；全局流响应优化的既有契约保持不变。
- 已核对 Runtime、HTTP、Web 和 Astron Pie 适配器；Astron 走全局 /events，Amio 使用独立适配器。实现位于 runtime.ts、protocol.ts、event-projection.ts、session-events.ts、server.ts 和 Web main.tsx / messages.ts；未修改 Cloud / Amio。
- 长历史回归已验证：会话事件不调用 readPath；60 条含历史图片的会话首屏只取 50 条，token 包小于 2000 字符且无 message / partial，分页可还原全部历史。并发首屏固定 leaf / revision，缓冲增量合并后与完整读取一致。
- 验证：在仅含本次提交内容的隔离快照中，`npm run check` 通过（Biome、Runtime / Web 类型与模型数据）；`npm run test:server` 164 项全部通过，含新增增量合并 / 分页 / 并发首屏、真实 SQLite、工具权限、取消、Subagent、压缩、重启和全局 SSE 契约。没有调用付费模型。
- Web 开发入口 `/main.tsx` 及其共享 `/@fs/.../session-events.ts` 经临时 Vite 实例实际请求均为 HTTP 200；未放宽 Vite 文件访问范围。未执行构建。
- 明确剩余边界：分页限制消息条数，不限制单条图片 / 工具结果的字节数；activities、配置、后台任务和显式完整读取的总量不在本次上限承诺中。Web 当前打开的消息视图仍随已加载页面与新消息增长，不新增前端 LRU。没有部署 Sidecar 或验证打包后的 Electron UI。
