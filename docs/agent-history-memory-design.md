# Agent 会话历史与内存设计对比

核验日期：2026-10-13。范围：历史正文的持有与加载、压缩后的工作上下文、会话卸载、历史分页。只做源码与官方文档调查，不修改运行时代码，不把未测量的 RSS 当作已知结果。

## 结论

Pie 最值得参考的是 OpenCode 的存储/上下文分离、Gemini CLI 的有限正文缓存，以及 Codex 的闲置运行时卸载。不是换一种落盘格式，而是明确三种数据各自的生命周期：

1. 完整历史：持久化的事实来源，供历史浏览、导出、分叉和故障恢复。
2. 工作上下文：摘要与最近消息，供正在执行的 Agent 使用，可以替换和释放。
3. 展示缓存：当前页面需要的消息，按页加载，不由每次运行事件重新携带全部历史。

这三者可以共用消息 ID，但不应共用一个永远增长、被所有路径强引用的完整数组。

Pi 上游自己的 SQLite 读取 PR 也值得优先参考，但必须区分旧 `coding-agent/SessionManager` 与新的 storage/durable 路线。后者的数据库范围读取，不能证明前者已经释放压缩前正文；关闭 PR 也不等于合并。

## 来源快照

| 项目 | 调查来源 | 固定提交 |
| --- | --- | --- |
| OpenCode | 官方 `anomalyco/opencode`，默认 `dev` 分支 | `5a4dd5b4301182591d48a93bbacdc5b7926cd3ca` |
| Gemini CLI | 官方 `google-gemini/gemini-cli`，默认 `main` 分支 | `51617c1bcbcb038291125b092501b4342f4e7f77` |
| Codex | 官方 `openai/codex`，默认分支 HEAD | `669449b02c4b58de4bcd22485eb60c98a6e38a54` |
| Claude Code | 官方 How Claude Code works 文档 | 查询时在线版本，无源码提交保证 |
| Pi 上游 | 官方 `earendil-works/pi`，默认分支 HEAD；相关 PR 单独读取 head ref | `7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6` |

源码项目通过独立临时 clone 核验，没有切换 Pie 或 Amio 工作树。OpenCode 当前上游的主要路径已经是 `packages/core/src/session`，不能把本机 Amio 的旧 `packages/opencode/src/session` 当成当前上游实现。

## OpenCode：在数据库查询时排除冷历史

### 已核实设计

- 会话元信息和消息分表：`SessionTable` 是 `session_v2`，`SessionMessageTable` 是 `session_message`。每条消息带独立 `id`、`session_id` 和 `seq`，数据库提供会话内序号索引，不再把完整 transcript 当成会话的一整个 JSON 字段。[表结构](https://github.com/anomalyco/opencode/blob/5a4dd5b4301182591d48a93bbacdc5b7926cd3ca/packages/core/src/session/sql.ts#L22)、[消息表与索引](https://github.com/anomalyco/opencode/blob/5a4dd5b4301182591d48a93bbacdc5b7926cd3ca/packages/core/src/session/sql.ts#L79)
- `SessionHistory` 先查询最新、已完成、可用于目标模型的压缩记录，然后只选择 `seq >= compaction.seq` 的消息。因此普通工作上下文不必先把整个历史正文解码到内存后再做 `slice`。[压缩边界查询](https://github.com/anomalyco/opencode/blob/5a4dd5b4301182591d48a93bbacdc5b7926cd3ca/packages/core/src/session/history.ts#L28)、[按边界加载](https://github.com/anomalyco/opencode/blob/5a4dd5b4301182591d48a93bbacdc5b7926cd3ca/packages/core/src/session/history.ts#L78)
- `SessionContext.load` 针对选定会话与模型调用 `entriesForRunner`，将查询结果作为工作消息，不是启动时把所有会话正文放入常驻 Map。[工作上下文加载](https://github.com/anomalyco/opencode/blob/5a4dd5b4301182591d48a93bbacdc5b7926cd3ca/packages/core/src/session/context.ts#L163)
- 完整历史浏览与工作上下文是不同接口：`SessionStore.messages` 支持 `cursor`、`limit` 和顺序；`context` 读取最新压缩边界后的上下文。[存储接口](https://github.com/anomalyco/opencode/blob/5a4dd5b4301182591d48a93bbacdc5b7926cd3ca/packages/core/src/session/store.ts#L42)、[消息分页与 context](https://github.com/anomalyco/opencode/blob/5a4dd5b4301182591d48a93bbacdc5b7926cd3ca/packages/core/src/session/store.ts#L140)

### 不能夸大的部分

边界后的工作消息仍通过 `.all()` 一次加载；没有压缩边界时，会加载当前会话的全部历史。分页接口的 `limit` 也是可选的，省略仍可全量返回。原生 Provider checkpoint 是否能回放受模型来源约束，不兼容时可能需要更长的原始历史。上述机制不等于整个进程、所有 UI 缓存或关闭自动压缩时都有硬性内存上限。[历史加载与来源限制](https://github.com/anomalyco/opencode/blob/5a4dd5b4301182591d48a93bbacdc5b7926cd3ca/packages/core/src/session/history.ts#L17)、[可选 limit](https://github.com/anomalyco/opencode/blob/5a4dd5b4301182591d48a93bbacdc5b7926cd3ca/packages/core/src/session/store.ts#L170)

本轮没有确认全部会话执行对象的闲置回收策略，也没有审计 UI 的所有历史缓存。不把这些未知项写成已经解决。

### 对 Pie 的启示

这是最直接的参考：利用现有 SQLite 增加消息粒度和稳定序号，把“加载工作上下文”与“读取完整 transcript”分成不同操作。只加一个内存索引、正文仍藏在整段会话 JSON 里，最终还是需要解析整个 payload，不能获得相同的加载行为。

## Gemini CLI：有界正文窗口与按需回读

### 已核实设计

- 录制服务写追加式 JSONL，更新以记录/patch 表达。内存中的 `cachedConversation.messages` 有明确的 50 条上限；超过后删除窗口前面的正文，另外保留 ID、消息类型和内容摘要等索引。索引只存内容 digest，不保存完整内容副本。[50 条配置](https://github.com/google-gemini/gemini-cli/blob/51617c1bcbcb038291125b092501b4342f4e7f77/packages/core/src/services/chatRecordingTypes.ts#L12)、[轻量内容指纹](https://github.com/google-gemini/gemini-cli/blob/51617c1bcbcb038291125b092501b4342f4e7f77/packages/core/src/services/chatRecordingService.ts#L196)、[索引与正文窗口](https://github.com/google-gemini/gemini-cli/blob/51617c1bcbcb038291125b092501b4342f4e7f77/packages/core/src/services/chatRecordingService.ts#L889)
- 写入一条消息时先追加日志，再更新轻量索引和有限正文窗口，不是每次重写完整会话。[追加与 trim](https://github.com/google-gemini/gemini-cli/blob/51617c1bcbcb038291125b092501b4342f4e7f77/packages/core/src/services/chatRecordingService.ts#L1038)
- 需要完整 conversation 时，`getConversation()` 才从磁盘回读；服务对完整回读结果只持有 `WeakRef`，下一次写入会让该缓存失效。弱引用不会单独阻止对象被垃圾回收，但调用方仍可持有强引用。[按需回读与弱引用](https://github.com/google-gemini/gemini-cli/blob/51617c1bcbcb038291125b092501b4342f4e7f77/packages/core/src/services/chatRecordingService.ts#L1257)、[写入使缓存失效](https://github.com/google-gemini/gemini-cli/blob/51617c1bcbcb038291125b092501b4342f4e7f77/packages/core/src/services/chatRecordingService.ts#L942)
- 工作历史另有 `AgentChatHistory` 强引用数组。摘要成功后，client 使用 `newHistory` 重建 chat；内容裁剪成功则调用 `setHistory(newHistory)`。`AgentChatHistory.set` 替换原数组，所以不是仅生成一个缩小的 Provider 输入投影。[强引用历史及替换](https://github.com/google-gemini/gemini-cli/blob/51617c1bcbcb038291125b092501b4342f4e7f77/packages/core/src/core/agentChatHistory.ts#L19)、[压缩后重建/替换](https://github.com/google-gemini/gemini-cli/blob/51617c1bcbcb038291125b092501b4342f4e7f77/packages/core/src/core/client.ts#L1236)、[setHistory 调用链](https://github.com/google-gemini/gemini-cli/blob/51617c1bcbcb038291125b092501b4342f4e7f77/packages/core/src/core/geminiChat.ts#L1345)

### 不能夸大的部分

50 条限制针对录制缓存，不是所有工作历史的 50 条限制，也不是字节上限。消息/工具索引仍可能随历史增长；初始化恢复和完整回读仍会临时加载完整正文。WeakRef 不保证 RSS 立即下降，更不能覆盖 UI、调用方或其他强引用。[恢复时加载](https://github.com/google-gemini/gemini-cli/blob/51617c1bcbcb038291125b092501b4342f4e7f77/packages/core/src/services/chatRecordingService.ts#L722)、[索引与弱引用字段](https://github.com/google-gemini/gemini-cli/blob/51617c1bcbcb038291125b092501b4342f4e7f77/packages/core/src/services/chatRecordingService.ts#L670)

JSONL 的原始字节与回读后的逻辑 transcript 也不是同一件事：`updateMessagesFromHistory` 可以追加 `removeIds`/顺序 patch，回读会应用这些修改。不能因为底层文件是追加日志，就推断普通回读永远返回压缩前的所有原始消息。[移除与顺序同步](https://github.com/google-gemini/gemini-cli/blob/51617c1bcbcb038291125b092501b4342f4e7f77/packages/core/src/services/chatRecordingService.ts#L1530)

### 对 Pie 的启示

可以借鉴“内存保留近期正文、冷正文按需读取”，但不必先引入 WeakRef：明确释放会话对象、有限大小缓存更容易验证。Pie 若要求导出/分叉保留原始 transcript，必须将其与会变化的模型工作历史分开，不能照搬逻辑 transcript 的删除 patch。

## Codex：替换工作上下文，并卸载闲置运行时

### 已核实设计

- 本地压缩生成新的 replacement history，随后调用 `replace_compacted_history`。底层 `ContextManager.replace_compacted` 把工作 `items` 指向新的 `Arc<Vec<...>>`，不是让原始工作数组继续无限增长。[压缩调用链](https://github.com/openai/codex/blob/669449b02c4b58de4bcd22485eb60c98a6e38a54/codex-rs/core/src/compact.rs#L392)、[历史替换](https://github.com/openai/codex/blob/669449b02c4b58de4bcd22485eb60c98a6e38a54/codex-rs/core/src/context_manager/history.rs#L719)
- App Server 将已加载运行时与持久化的任务视图分开。`thread/loaded/list` 查询 ThreadManager 当前加载的 ID；`thread/read` 读取持久视图和已有运行时信息，不把历史读取当成启动执行。[loaded/list 与 read](https://github.com/openai/codex/blob/669449b02c4b58de4bcd22485eb60c98a6e38a54/codex-rs/app-server/src/request_processors/thread_processor.rs#L2887)
- 闲置卸载需要同时满足“没有订阅者”和“没有活动执行”，在二者都满足后等待配置的延迟。状态改变会重新判断，正在执行的任务或仍有订阅者的任务不会因这一条件被直接卸载。[卸载条件](https://github.com/openai/codex/blob/669449b02c4b58de4bcd22485eb60c98a6e38a54/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L23)
- 超时卸载会移除运行时、监听与 watch 状态，并发出 `thread/closed`。已有专门测试覆盖“取消订阅不立即卸载”和“活动回合继续运行”。[卸载完成路径](https://github.com/openai/codex/blob/669449b02c4b58de4bcd22485eb60c98a6e38a54/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L398)、[取消订阅测试](https://github.com/openai/codex/blob/669449b02c4b58de4bcd22485eb60c98a6e38a54/codex-rs/app-server/tests/suite/v2/thread_unsubscribe.rs#L44)
- 历史读取协议支持按 turn/item 游标分页；`ThreadReadParams` 明确建议分页任务使用 metadata-only read，再分页读取 turns/items。不能把这一点概括为所有模式与客户端都已默认分页。[read 参数](https://github.com/openai/codex/blob/669449b02c4b58de4bcd22485eb60c98a6e38a54/codex-rs/app-server-protocol/schema/typescript/v2/ThreadReadParams.ts#L5)、[turns 分页](https://github.com/openai/codex/blob/669449b02c4b58de4bcd22485eb60c98a6e38a54/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTurnsListParams.ts#L7)、[items 分页](https://github.com/openai/codex/blob/669449b02c4b58de4bcd22485eb60c98a6e38a54/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItemsListParams.ts#L7)

### 不能夸大的部分

替换主工作数组不代表所有旧内容立刻释放。当前源码还处理 Guardian 审核上下文：某些旧审核模式会保存独立 `review_history`，快照的 `Arc` 共享也可能延长旧对象生命周期。因此只能确认主工作窗口被替换和运行时可卸载，不能宣称所有模式下整个进程内存恒定。[审核历史的保留分支](https://github.com/openai/codex/blob/669449b02c4b58de4bcd22485eb60c98a6e38a54/codex-rs/core/src/context_manager/history.rs#L719)

本轮没有核实各发行版默认卸载延迟，不将某个文档或测试中的秒数作为通用产品默认值。官方 App Server 网页本次直接请求返回 403，相关结论改由同厂官方源码与测试核验，不依赖网页搜索片段。

### 对 Pie 的启示

长期驻留的是服务，不需要每个会话 Agent 对象也永久驻留。卸载不等于删除历史；再次使用时可从持久 checkpoint 与近期消息重建。Pie 的保护条件除了 active turn，还必须覆盖后台子任务、排队消息、等待确认和后台完成通知。

## Claude Code：官方能确认什么

官方文档说明每条消息、工具调用与结果写入本地 JSONL；上下文接近上限时先清理旧工具输出，再按需摘要；子 Agent 使用独立上下文，只向父任务返回结果摘要。[官方工作原理](https://code.claude.com/docs/en/how-claude-code-works#work-with-sessions)

这能支持“持久历史、工作上下文和子任务上下文应分开”的产品行为，但文档没有证明其内部正文对象如何卸载或 RAM 是否有硬上限。本轮没有取得其运行时内部实现，不拿它给内存回收背书。

## Pi 上游 PR：借鉴按需读取，不照搬截断

以下同时检查 PR 正文、官方 PR head 的代码差异以及 `merged_at`。日期按 UTC；`closed` 而 `merged_at = null` 的提案不标成已合并。Core REST API 本次限流，合并时间改由官方搜索 API 的精确编号结果核验，代码通过官方 `refs/pull/<number>/head` 获取。

| PR | 核验状态 | 解决的具体问题 | 对 Pie 的价值 |
| --- | --- | --- | --- |
| [#7408 feat(agent): add storage-owned session readers](https://github.com/earendil-works/pi/pull/7408) | 已合并，2026-07-31 | 存储拥有读取对象，取代打开会话就取得完整 snapshot；SQLite 按 ID、序号分页、压缩边界读取 | 优先借鉴读取语义：元信息、工作上下文、完整历史分别读取 |
| [#7431 Make SQLite branch caching scalable](https://github.com/earendil-works/pi/pull/7431) | 已合并，2026-08-01 | 持久化完整分支路径，但普通工作读取只取压缩保留窗口；分支前缀以 SQL 事务复制 | 优先借鉴稳定 entry ID/seq、范围查询，以及不解码全部正文的分叉 |
| [#7450 Use type index for SQLite compaction discovery](https://github.com/earendil-works/pi/pull/7450) | 已合并，2026-08-01 | 用类型索引先发现稀疏的压缩条目，而非扫描整个分支后过滤 | 第二步查询优化；不是独立的正文回收方案 |
| [#2749 fix: cap in-memory `fileEntries` array to prevent unbounded heap growth](https://github.com/earendil-works/pi/pull/2749) | 已关闭、未合并，2026-04-01 | 默认只保留 1000 个 entry，并从索引删除被裁剪条目 | 诊断方向相关，但不直接采用其截断实现 |

### #7408：最直接的接口参考

`getMetadata()` 返回元信息；`getEntries(options)` 支持 `afterEntrySeq` 和 `limit`；`buildContext()` 使用分支读取，而不是默认取得完整 transcript。SQLite `readEntry()` 按需查单条，`readPathToRootOrCompaction()` 沿当前分支读取到压缩保留位置。[Session 接口与实现](https://github.com/earendil-works/pi/blob/2366649ba4966d9b7c057b0a19ec54c135fa9f3b/packages/agent/src/harness/session/session.ts)、[SQLite 读取](https://github.com/earendil-works/pi/blob/2366649ba4966d9b7c057b0a19ec54c135fa9f3b/packages/storage/sqlite-node/src/sqlite/storage/index.ts)

限制：无分页参数的 `getEntries()` 仍全量读取；名称、标签、统计的派生状态首次使用仍可能读取全历史；JSONL adapter 仍解析整文件。SQLite 已读正文还进入 `byId`，该 PR 没有增加淘汰机制。因此它降低打开会话时的加载量，不保证同一个会话运行数日后正文缓存仍有界。测试重点是上下文构造不调用全历史读取、序号分页与缺失活跃叶校验。[读取计数测试](https://github.com/earendil-works/pi/blob/2366649ba4966d9b7c057b0a19ec54c135fa9f3b/packages/agent/test/harness/repo.test.ts)、[SQLite 测试](https://github.com/earendil-works/pi/blob/2366649ba4966d9b7c057b0a19ec54c135fa9f3b/packages/agent/test/harness/sqlite-migrations.test.ts)

### #7431：完整路径留在数据库，工作读取只取窗口

完整 root-to-tip 路径通过 `branch_entries`/`branch_tips` 持久化。正常读取先找到压缩条目与 `firstKeptEntryId` 对应的 seq，再用 `BETWEEN startSeq AND leafSeq` 读取正文。创建分支以事务内的 `INSERT ... SELECT` 复制前缀，避免先把全部 ID/正文搬进 JavaScript 再逐条写入。[范围读取与 SQL 前缀复制](https://github.com/earendil-works/pi/blob/e92bf60a5804e1640b9ea7390a03c4063adc880f/packages/storage/sqlite-node/src/sqlite/storage/branch-cache.ts#L26)、[压缩边界解析](https://github.com/earendil-works/pi/blob/e92bf60a5804e1640b9ea7390a03c4063adc880f/packages/storage/sqlite-node/src/sqlite/storage/index.ts#L74)

一个有价值的回归测试：故意将压缩边界之前的旧消息 payload 改成无效 JSON，正常 `getBranch()` 仍成功并只返回保留窗口。这比“返回数组短了”更能证明冷正文没有被解析。另有嵌套压缩、缺失缓存修复、修复中断回滚和事务分叉测试。[冷正文不解析测试](https://github.com/earendil-works/pi/blob/e92bf60a5804e1640b9ea7390a03c4063adc880f/packages/agent/test/harness/sqlite-branch-cache.test.ts#L44)

限制：缓存缺失或失效时，修复路径仍可能读取完整父链；读取和追加仍会向连接的 `byId` 保存正文。它解决数据库读取范围、分支正确性和 SQL 参数限制，不是完整的运行时正文回收证明。

### #7450：避免压缩边界查询本身退化为全路径扫描

该 PR 仅修改压缩条目的发现查询：以 `idx_session_entries_session_type` 驱动查询，再过滤分支与叶序号。它没有新增分页、metadata-only 读取或缓存淘汰。Pie 在消息分表以后可以借鉴压缩记录索引，但现在增加索引不能弥补整段会话 payload 的加载方式。[固定差异](https://github.com/earendil-works/pi/commit/eb2683fc59957abc93db8c06f657aa953fbba044)

### #2749：问题相同，但裁剪语义不适合直接照搬

`_pruneIfNeeded()` 从数组头部移除旧 entry，同时删除 `byId` 和标签索引，没有为旧 entry 实现透明回读。PR 正文明确承认旧分支访问会截断；测试也接受旧 entry 查询变成 `undefined`、分支变短，而非保证完整历史语义不变。保留磁盘文件并不自动让所有现有读取接口保持完整。[裁剪实现](https://github.com/earendil-works/pi/blob/d78dc7d434b951fd8a4d3b3ab6d28ee3db22a415/packages/coding-agent/src/core/session-manager.ts#L842)、[裁剪测试](https://github.com/earendil-works/pi/blob/d78dc7d434b951fd8a4d3b3ab6d28ee3db22a415/packages/coding-agent/test/session-manager-pruning.test.ts)

对 Pie，直接裁剪 `state.messages` 还会破坏数组位置 checkpoint 和完整导出/分叉。1000 条也只是数量限制，不是字节硬上限。可以借鉴其强调的强引用诊断，不采用这个实现作为最小修复；也不根据“未合并”推测维护者拒绝支持长期运行。

### 不能混淆上游两条运行路径

核验的当前上游 `coding-agent/SessionManager` 仍有 `fileEntries` 和 `byId`，追加同时保存完整 entry，没有因为上述 SQLite PR 就自动变成冷正文索引。[当前旧 SessionManager](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/core/session-manager.ts#L994)、[追加路径](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/core/session-manager.ts#L1191)

新的 `packages/durable` 则先捕获 head marker 与 tail，再按范围分批读取；同一 head 下可增量扩展已读上下文，head 改变时重新构造工作范围。每页 256 条只是查询批大小，扫描结束仍会把整个选定范围放进数组；没有 head 时范围从 transcript 起点开始。因此也不能将“支持分页”写成“工作内存始终最多 256 条”。[范围捕获与增量读取](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/durable/src/harness/context.ts#L23)、[范围与分页汇总](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/durable/src/harness/context.ts#L228)

Pie 应借鉴这些接口行为与回归测试，继续使用自己的 SQLite 和 Agent loop，不为解决冷历史正文常驻就引入整套新 harness、分支树或额外数据库。正常工作读取不触及冷正文，与压缩/闲置后确实释放正文引用，是两项都要验收的要求。

## Pie 现状与必须保留的行为

- `store.ts:77` 启动时读取所有会话 payload；`server.ts:209` 放入常驻 Map。SQLite 落盘没有避免全量正文常驻。
- `compaction.ts:138` 与 `compaction.ts:262` 只生成模型请求投影，没有替换 Agent 的完整原始历史。
- `server.ts:298` 在每次持久化时保存整个会话 JSON；`server.ts:580` 的会话级 SSE 每个事件都携带完整 snapshot。全局 SSE 已有精简投影，不应与会话级路径混为一谈。
- `protocol.ts:182` 的 checkpoint 使用数组位置：`firstKeptMessage`、`turnStartIndex`、`messageCount`。直接裁掉数组前段会让位置含义失效。
- `server.ts:246` 的分叉读取完整历史；`session-transfer.ts:317` 的导出依赖原始消息和导入 transcript 前缀。只截断 `state.messages` 会同时改变历史浏览、导出与分叉结果。

所以不是“把旧 messages 清掉”一处修改。必须先让完整历史有独立事实来源，才能安全释放工作历史的强引用。

## 建议的最小落地顺序

### 第一阶段：分离完整历史与工作上下文

继续使用现有 SQLite，不增加数据库或另一套 Agent 运行时。

- 会话元信息与消息正文分开存；消息具有稳定 ID/绝对 seq，支持追加和流式消息的必要更新。
- 启动只读会话摘要；执行时按 checkpoint 边界读取摘要与近期消息。避免查询全部 payload 后才提取摘要。
- 压缩成功先可靠写入 checkpoint，再替换工作历史；失败或取消不改变现有上下文。工具调用与结果配对、当前用户图片必须保留。
- checkpoint、分叉、导出和导入前缀使用持久消息身份/绝对位置，不依赖被裁剪数组的下标。
- 旧数据库迁移必须保留历史、活动记录、导入前缀和异常中断事实；不能借内存优化丢掉这些功能。

必要性：同时解决“启动读所有会话”和“同一个会话持续累积”。仅在闲置时清掉 Agent，但 Map 仍保存 `session.messages`，不解决正文常驻。

### 第二阶段：明确运行时释放条件

- 回合结束且不存在待执行消息、待确认交互或相关后台工作时，释放 Agent 及其工作正文引用；短时间保留窗口可以作为实测后的优化，而不是先做复杂缓存。
- 后台任务完成通知需要能够加载会话并恢复工作上下文，不能因 UI 断开而丢失。
- 只保留有必要的小元信息；监测所有正文强引用，包括 `transferBase`、任务闭包和返回给调用方的 snapshot。

必要性：历史分离后仍要避免闲置运行时持有窗口和工具资源。卸载不能中断真正还在执行或等待通知的任务。

### 第三阶段：分页展示和增量事件

- 历史浏览按游标加载；连接初始化获取近期页和 revision，向上滚动再读取冷页。
- 实时事件复用现有 Agent event/progress 路径，不再每次携带全部 transcript；断线恢复按 revision 重新同步必要状态。
- 模型上下文不混入 UI 心跳；完整导出与分叉从存储读取，不能从某个 UI 页或工作窗口凑历史。

必要性：避免冷历史已经从 Agent 释放，却因为 snapshot 序列化、浏览器展示或宿主缓存再次全量加载。这个阶段应覆盖 SDK / HTTP / 嵌入宿主的事件与分页契约；自带测试 UI 已移除，见 [删除 SPEC](specs/remove-bundled-web.md)。

## 不建议现在增加

- 不为了这一问题更换 SQLite，或引入 Redis、向量库、分布式缓存与新的事件协议。
- 不把 WeakRef 当成正确生命周期管理的替代品。
- 不把“仅剩最近 N 条”当作字节上限：一条图片或工具结果也可能很大。需要分别考虑消息数量、实际字节与模型 token 预算。
- 不只观察压缩后 RSS 有没有马上下降。应验证对象是否仍有强引用、长期 live heap 的增长趋势，以及序列化与恢复的峰值。

## 实施后的验收

1. 增加很多闲置会话后，启动时不解码其正文，常驻内存不跟全部历史字节同比增长。
2. 同一会话连续执行多轮并反复压缩，工作正文随窗口变化，而不是持续包含所有已压缩消息。
   - 增加类似上游 #7431 的定向测试，证明构造工作上下文不会读取或解析压缩边界之前的冷正文；完整历史的按需读取另行验证。
3. 旧工具结果和图片从工作上下文退出后，历史浏览、导出、分叉仍可读回原始数据。
4. 冷会话加载、后台通知、取消、重启恢复和失败 checkpoint 不丢消息、不重放已执行工具。
5. 长历史 SSE 与浏览器只加载必要页；压力测试分别记录 live heap、RSS、数据库读取和序列化峰值。

本轮没有安装依赖、调用收费模型、运行构建或修改任何运行时代码；这里只提出设计路线。没有进行跨产品 RSS 对比，源码中的局部窗口控制不被表述成整进程硬上限。
