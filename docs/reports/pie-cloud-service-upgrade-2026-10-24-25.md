# PIE 服务化升级说明：从内存常驻到按需重建

改动阶段：2026-10-24 至 2026-10-26。更新日期：2026-10-26。保留原文件名，补入统一执行账本与同工作树的流式工具提前执行改动。

本文面向 PIE 与 `cowork3/cloud/apps/agent-service` 开发者，按当前工作树、阶段 SPEC 和已记录测试结果整理。这些实现尚未提交；日期来自实施记录，不是 Git 提交日期。配套演示版：[离线 HTML](pie-cloud-service-upgrade-2026-10-24-25.html)。

## 1. 结论

本轮的目标不是让执行过程中没有内存状态，而是让**关键事实不只存在于某个进程里**：指定会话可按需装载，执行结果可靠提交后可释放，实例退出后可在安全边界重建；工具执行通过持久账本记录确定边界，外部异步任务通过原身份查询结果，而不是依赖原实例的回调。

对 agent-service 的直接帮助是：减少冷启动和空闲会话驻留成本，让滚动更新、实例替换及后续多实例接管有共享契约可用；不必为了这些差异在云端复制另一套 Agent Loop。

**交付边界：PIE 侧已实现并完成本地自动回归，不等于 Cloud 已接入，更不等于已经完成生产级故障恢复。** 这次没有修改 Cloud 或 Astron/Amio Core，也没有构建、部署或进行真实云端验收。

### 三个容易混淆的概念

| 概念 | 含义 | 本次做到什么 |
| --- | --- | --- |
| 执行时有状态 | 模型上下文、Agent、Promise、取消信号在内存中 | 正常且必要，不试图消灭 |
| 服务可替换 | 正确性不依赖某个固定实例，外部事实足够重建 | 提供按需装载、可靠保存、释放和恢复入口；Cloud 须接入共享存储与归属管理 |
| 任务可恢复 | 执行一半退出后，从明确的安全位置继续 | 支持已提交消息边界和已关联外部任务的结果接回；不恢复任意代码行或 Promise 栈 |

`runtime` 是共享会话与执行管理器，不是某个 Assistant 的 prompt 模板，也不是必须为每个用户常驻一个 Agent。Assistant 是配置，Session 是持久会话，Turn 是一次完整用户提交，Agent 是执行对象。Cloud 如何按租户/用户限定 Runtime 范围由宿主负责；各 Session 仍需隔离和单一执行归属。

恢复模型统一为 **Turn → ToolExecution**。Job 不是与 Turn 平级的恢复对象，只是外部执行器适配名称；Task 和其他工具也使用同一套执行身份与事实记录。执行模式分为普通调用 `inline`、委派调用 `delegated` 和持久外部执行 `durable`，不意味着三者都已支持跨进程续跑。

## 2. 先区分：既有基线与本次新增

| 时间 / 范围 | 已有能力或本次改动 | 与本次工作的关系 |
| --- | --- | --- |
| 10 月 15–16 日既有基线 | `runtime/local/server` 分层；宿主注入能力；历史与正文按需读取；`release-after-turn`；Session 增量事件与分页引导 | 本次沿用，不把这些全部重复记成本轮的新功能 |
| 10 月 24 日 | 按 ID 装载元信息、独立分页列表、空闲整个 Session 回收；Turn checkpoint、共享恢复判定和显式恢复入口 | 补齐“能轻量装载一个会话”和“重建后从哪继续” |
| 10 月 24–25 日 | 恢复路径只读当前 Turn；无效路径安全拒绝；历史分页和压缩工作窗口在 SQL 递归中停止 | 避免接口看似分页，底层仍扫描长历史 |
| 10 月 25 日 | 外部任务稳定关联、先保存再提交、查询旧结果后继续原 Turn、关闭与取消区分 | 补齐“原回调丢失后如何接回异步结果” |
| 10 月 26 日 | 统一 ToolExecution 账本、确定边界、结果与账本原子提交、独立游标分页 | 补齐“如何证明工具执行到了哪一步”，不再仅依赖当前 checkpoint 或内存对象 |
| 10 月 26 日，同工作树并行改动 | 完整工具调用可在模型流结束前启动；开始前保存调用快照 | 优化等待时间，同时保留执行前落库和下一轮模型请求屏障；不是新增流中断恢复能力 |

## 3. 改了哪些部分，为什么有帮助

### 3.1 单会话按需装载，而不是启动预载全部会话

**原问题：** Runtime 通过 `loadSessions()` 预载范围内全部 Session 元信息。即使只访问一个会话，也要建立许多不会执行的内存对象。

**现在：**

- 用 `RuntimeStore.readSession(id)` 替换全量启动接口；`createRuntime` 本身不读取会话。
- `listSessions({ limit, cursor, ...filters })` 单独查询元信息，不激活 Agent、不读取正文。按 `updatedAt DESC, id DESC` 排序，同时间戳有稳定游标。
- 同 ID 并发访问合并装载；未由宿主完成恢复的 `running` 会话只在访问目标时拒绝，不拖垮其他会话。
- `release-after-turn` 在可靠收尾、没有活动引用时释放 Agent、工作消息及整个 Session 缓存。订阅仍存在时可保留轻量元信息；执行、确认、后台任务、读操作及写入失败会阻止不安全回收。
- 父会话删除查询存储中的全部子会话，不再假设未装载的子会话不存在。

**例子：** 一个范围有大量历史会话，只访问 A 时，不应创建 B、C 等冷会话的执行对象。查看列表与执行 A 是两种独立操作。

**对 agent-service：** 用户历史规模不再直接决定 Runtime 启动的对象数量；空闲用户不必持续占用全部执行态内存。收益需要 Cloud Store 和工厂同步新契约后才成立，不代表已经测得某个 RSS 降幅。

### 3.2 读取必须在存储层停止

**原问题：** 分页 API 不一定意味着数据库少读。先递归整条父链，再切出一页，长历史仍会扩大查询成本。

**现在：**

- SQLite 的 `readHistory` 沿当前分支反向累计 `limit + 1` 个符合游标的候选节点后停止，再判定下一页。
- `readWorkingPath` 遇到压缩工作边界 `firstKeptEntryId` 和可选 `turnStartEntryId` 后停止，只解码工作窗口。
- 新增 `readTurnPath`，恢复判定只读取当前 Turn 输入节点到叶子的后缀，不把前几千轮历史一并解码。
- 缺失、跨分支、断链或循环的 checkpoint 明确拒绝恢复；需要补写未知工具结果等失败修复时，仍可能回退完整路径。

**对 agent-service：** 提供了 MySQL/远端 Store 必须遵守的读取语义，减少历史长度对普通读、恢复检查和模型准备的牵连。PIE 的 SQLite 优化不会自动优化 Cloud 的 SQL，服务端须独立实现并计数验证。

**边界：** 条数受控不等于字节数受控。单条大图片、巨大工具输出、超长当前 Turn、完整树、导出和显式全量快照仍可能昂贵。没有压缩边界时也不保证工作窗口固定大小。

### 3.3 以 Turn 为恢复任务，在已提交消息边界继续

**原问题：** 重启后读到会话，只能证明历史还在，不能证明执行能从中间继续；直接再次提交用户输入可能重复产生工具副作用。

**现在：**

- 持久化 `TurnCheckpoint`：版本、原 `turnId`、输入节点、实际完整 system prompt、取消意图及可恢复性限制。原配置、助手版本、模型身份继续使用已有持久字段，不保存模型凭据。
- `recoverInterruptedTurn(metadata, tree)` 只做判定，不执行工具或写库。
- `interrupted` 表示等待显式恢复或取消；`resumeTurn` 保持原用户输入、`turnId/requestId` 和已应用配置，不走新 `submitTurn`。
- 准入保存成功后才运行模型；保存失败不启动模型。实例内并发恢复不能同时推进同一 Turn，但这不是分布式锁。
- 最终 Assistant 已提交但 Turn 未结算时，只补结算，不再次生成回答。

Turn checkpoint 记录执行身份与继续位置；压缩 checkpoint 记录模型工作上下文保留边界。二者用途不同，不能互相代替。

**一条具体时序：**

```text
用户输入落盘 → 工具调用落盘 → 工具结果落盘 → 实例 A 退出
实例 B 取得归属 → 核对 checkpoint 与工具事实 → 恢复原 Turn → 模型继续
```

工具结果已经落盘，不重新执行工具。若只有调用而没有结果，也没有可查询的外部任务关联，则记录结果未知并拒绝盲目续跑；不能推断“没结果就是没执行”。未提交的流式片段不恢复。

**对 agent-service：** 宿主可以把实例故障处理接到同一套执行语义，不必通过复制消息或新建 Turn 猜测续跑位置。跨实例接管前仍须授权、取得有效租约并阻断旧实例提交。

### 3.4 外部异步任务：接回结果，不恢复旧 Promise

**原问题：** 内存 job 容器的 Promise 和 callback 随实例消失；远端任务可能仍在运行，但新实例不知道它是谁，也收不到旧回调。

**现在：** 宿主可注入 `DurableJobExecutor`，工具经权限核对后调用 `context.runJob(toolCallId, signal)`。

```text
保存稳定任务关联与 submission_intent（同一事务）
  → 宿主 submit（幂等；远端 taskId 映射须持久化）
  → 收到确认后记录 submitted
  → 正常执行期间查询结果
  → 实例中断后，新实例 get 原任务
  → 全部缺失结果明确后，与终态账本、恢复准入原子提交
  → 继续原 Turn，不重新 submit
```

| 查询结果 / 故障 | PIE 行为 |
| --- | --- |
| `running` | 恢复返回 409，暂不推进；由宿主之后再次触发 |
| `completed` 且结果有效 | 保存原工具结果，再请求模型 |
| 已知 `failed/cancelled` | 作为工具错误结果交给原 Loop，不重启任务 |
| missing、unknown、身份不符、完成但缺少结果 | 拒绝继续，不自动重新提交 |
| 提交响应丢失或查询故障 | 保留原关联和已提交历史，不把本地中止伪装成实际工具失败 |
| 服务正常关闭 / 更新 | 解除本实例等待，不请求取消外部任务 |
| 用户显式取消 | 先保存意图，再请求执行器取消；保留任务身份，最终状态及副作用仍需核对 |

结果支持文本、图片、结构化 details 与 usage。旧结果已提交则不重复消费，不依赖一定收到通知。任务执行器资源由宿主管理；当前没有自动轮询恢复调度器。

**对 agent-service：** 可以把已有工具执行账本/Worker 任务状态映射到共享恢复契约，通知只负责唤醒，持久查询结果才是事实。原实例消失不再意味着必须重发有副作用的动作。

**没有做到：** 原本地 Shell、后台 Subagent、内存 `BackgroundJobs` 不会自动变成持久任务；外部 Worker 若自身也退出，工具内部从哪继续仍由其 checkpoint/幂等策略决定。PIE 不实现 Redis、任务平台或任意代码行恢复。

### 3.5 统一执行账本：知道工具到了哪一步，而不只是知道消息还在

**原问题：** checkpoint 负责重建当前 Turn，但它会在终态清理；仅有 Promise、任务关联或工具返回值，无法可靠说明“执行已开始”“提交是否确认”“结果是否已经和历史一起提交”。

**现在：** 每次工具执行有稳定身份，记录属于同一 Session/Turn/toolCall 的确定事实。结果正文继续使用历史节点，不在账本重复保存。

| 账本事实 | 何时记录 | 不代表什么 |
| --- | --- | --- |
| `started` | 工具副作用开始前，先可靠保存 | 不代表工具尚未生效，也不代表工具已经完成 |
| `submission_intent` | 外部提交前，与任务关联原子保存 | 不代表远端没有收到；提交响应可能丢失 |
| `submitted` | 实际收到执行器提交确认后 | 不代表远端工作已完成 |
| `completed` / `failed` | 工具后处理后的结果与历史同事务提交 | 工具失败不等于外部副作用已撤销 |
| `recovery_required` | 提交/查询异常、取消结果未知或后台完成未知等边界 | 不代表成功，也不是新的公开 Turn 状态；突然退出可能来不及记录它 |

**一条具体时序：**

```text
started 落库 → 关联 + submission_intent 落库 → 外部提交确认 → submitted 落库
  → 实例 A 退出 → B 取得归属并核对账本/历史/原任务 ID
  → 查询原任务 → 明确结果 + 终态账本 + 恢复准入同事务提交 → 原 Turn 继续
```

如果没有收到提交确认，不能据此断定远端未执行；恢复只查原 ID，不自动重提。若账本写着终态但缺少配套历史结果，PIE 会在查询执行器或创建 Agent 前拒绝恢复。存储屏障失败后，本实例也不能在收尾时绕过账本单独保存结果。

账本使用独立追加存储，不放进 Session 元信息或 checkpoint 数组；`readToolExecutions(sessionId, { turnId, limit, afterSeq? })` 每页读取 1–200 条。账本 seq、历史 seq 和事件 revision 是三个不同维度。清理 checkpoint、进入下一轮或重启不删除账本，删除 Session 才级联清理；普通列表、快照和 SSE 不携带完整账本。

**对 agent-service：** 不同实例可核对同一套持久执行事实，不依赖原实例内存；Cloud Store 必须把历史、Turn 元信息和本次账本增量放进同一事务，并实现存储侧分页。仅声明 `toolExecutionMode: "durable"` 不会让本地 Promise 自动具备接管能力。

### 3.6 流式工具提前执行：减少等待，但不放松恢复边界

这项是同工作树并行完成的执行时序优化，不是服务可替换的前提，也不把流式 token 变成可恢复状态。

- 只有收到明确的 `toolcall_end` 且原始参数可严格解析，才允许完整调用在剩余模型输出期间提前执行；缺少必要事件或原始参数时，回退到整条响应结束后的执行方式。
- 工具开始前仍经过权限与持久化屏障。Runtime 将调用快照保存为 `pendingAssistant`，同时提交 `started`；最终 Assistant 消息提交后清除快照。
- 下一次模型请求仍等待本条响应结束和本批工具结果；保留结果顺序、串行规则和取消/失败收束，不重复执行提前完成的调用。
- 若工具已经启动，但最终 Assistant 响应尚未提交就崩溃，保留调用快照与账本审计，拒绝盲目续跑，不伪造历史。

**对 agent-service：** 工具耗时有机会与剩余模型输出重叠；是否有收益取决于 Provider 的事件能力。它同时解释了为什么“模型整条消息还没落盘”不等于“工具肯定没执行”。

### 3.7 本地宿主与 Web 一起迁移，不让云端优化破坏本地使用

- 本地继续默认 SQLite、`retain` 和现有模型/工具/Skill/MCP 装配，不增加 Redis、MySQL、云账号或 Worker 启动依赖。
- 本地 `PI_TURN_RECOVERY=manual` 显式启用恢复；默认仍按中断失败修复，避免尚未支持恢复入口的 Astron 宿主被卡在 `interrupted`。
- 本地 HTTP 增加 `POST /sessions/:id/resume`；Web 显示继续/停止，在处理完中断 Turn 前禁发下一轮或替换历史。
- 共享 `subscribe` 改为异步装载；HTTP/SSE 同步适配异步订阅和连接提前关闭。
- Runtime 列表默认分页 50 条；本地封装按页汇总，HTTP `GET /sessions` 保持原 `{ sessions }` 完整列表形状，未因此激活所有会话。
- SQLite 首次升级事务性建立迁移/恢复/列表索引；后续不在启动保留全部元信息数组。节点 ID、分支、导入原文、图片及工具结果保留，不要求删库重建。
- 本次新增独立执行账本表及索引，工具边界会增加可靠写入；不要求本地每轮都销毁 Agent。支持提前执行的 Provider 可能更早启动完整工具调用，但下一次模型请求仍等待结果。

**对 agent-service：** 公共层提供一致语义，宿主选择存储与保留策略，而不是用环境判断在 PIE 内部硬编码“本地/云端两种逻辑”。本地回归同时约束云端所复用的执行语义。

### 3.8 增量事件是继续沿用的基线，不是本轮重做了一遍

Session 增量事件、revision、分页初始视图和 `readHistory` 补读在此前已完成。本次继续保留并回归它们，新增的恢复状态和异步装载也须与事件消费端衔接。

事件 revision 与历史节点 seq 是不同维度，不能混用成一个游标；事件缺口需要重新引导，历史分页则沿 seq 与分支叶子补读。

**对 agent-service：** 如果 Cloud 仍为每个 token 构造/转发完整 snapshot，PIE 的轻量事件收益会在宿主层丢失。需要同步 RuntimeManager、跨实例路由以及 WS/SSE 消费端，处理序号缺口、分支切换和重新引导。

默认完整详情、导出或显式完整快照仍可能全量读取；不能把“token 流不带完整快照”写成“所有 HTTP 读取都已经有界”。

## 4. agent-service 应负责什么，PIE 应负责什么

| 职责 | PIE 共享层 | agent-service / 云端基础设施 |
| --- | --- | --- |
| 会话与执行 | Session/Turn、历史/分支/压缩、Agent Loop、恢复判定与入口 | 产品会话 API、授权范围、请求路由 |
| 持久化 | 按需读取、独立执行账本，以及历史/元信息/账本原子提交契约 | MySQL/Redis/对象存储实现、索引、事务、连接池 |
| 配置与能力 | 使用宿主注入的模型、工具、Skill、MCP 与请求记录 | 按租户/用户解析配置、凭据、SDK 和资源授权 |
| 执行归属 | 不实现租约或跨节点锁 | 认领/续约、代次校验、失租隔离、阻断旧 owner |
| 工具与外部执行 | 统一 ToolExecution 事实、保存稳定关联、查询结果、原 Turn 接回 | 共享账本存储、幂等映射、Worker、结果保存、取消与工具内部恢复 |
| 消息连接 | 增量事件和补读契约 | WS/SSE、Redis 通知、跨实例投递、背压与断线重连 |

服务化不等于“Map、WS、Promise 都禁止存在”。这些对象可以是实例内的临时状态；不能让关键数据或可恢复进度只存在于它们里面。连接断开后的会话重建也不等于恢复同一条 TCP/WS 连接。

## 5. 当前 Cloud 差距与建议接入顺序

以下沿用此前 2026-10-26 对 `cowork3/cloud` 本地源码的只读核对记录；本次文档更新未重新核对 Cloud 工作树，未运行 Cloud 测试或确认生产部署：

- Cloud 已有 MySQL RuntimeStore、执行归属/跨实例路由和工具执行层，不应把它描述为从零开始的空骨架。
- `cloud/packages/pie/runtime/src/runtime.ts` 和 `apps/agent-service/src/model/mysql-runtime-store.ts` 仍使用 `loadSessions()`。
- `runtime-factory.ts` 已启用 `release-after-turn`，但仍全范围恢复并收集 `loadSessions()` 配置引用；仅升级 PIE 内部无法消除这段工厂成本。
- `runtime-manager.ts` 仍读取 `event.snapshot` 并构造带 snapshot 的 Cloud 事件。需要衔接共享增量契约，不是复制五个包就完成。

建议由服务端按以下顺序增量接入：

1. **固定同步基线。** 仅合并 `agent/ai/mcp/telemetry/runtime` 五个共享包；三方增量合并，保留同事改动，不覆盖整个目录，不把 Local/Server/Web 搬进云端。
2. **迁移 Store 和工厂。** 实现 `readSession`、游标 `listSessions`、`readTurnPath` 和 `readToolExecutions`；`saveSession` 必须原子保存历史、元信息与增量账本，不能忽略第三个参数或提交后再补写。工厂改为目标会话恢复和配置解析，专门管理必须的全范围管理查询。
3. **迁移事件消费者。** 适配异步订阅、增量包、bounded bootstrap/历史补读；覆盖 Redis 路由、WS/SSE 与断线重同步，不再每 token 生成完整视图。
4. **接入 Turn 恢复。** 持有有效归属后分类，开放 resume/cancel，并检查旧 owner 失效后不能继续写；保留原 Turn/config/prompt。
5. **映射外部任务。** 用已有账本/Worker 状态实现并注入 `DurableJobExecutor`；稳定 ID 与远端 taskId 持久映射，完成结果先保存，通知可丢但查询可达。
6. **联合故障验收。** 验证 A 退出/B 接手、丢通知、提交响应丢失、DB 故障、取消与滚动更新、失租旧实例写入、冷历史/大消息成本。健康接口 200 或本地假模型测试不能替代这些验收。

### 共享接口迁移清单

| 变更 | 消费端必须处理 |
| --- | --- |
| 删除 `RuntimeStore.loadSessions` | 实现按 ID 和分页读取，移除正常启动全量预载 |
| 新增 `RuntimeStore.readTurnPath` | 返回原节点身份的当前 Turn 路径后缀，不能用未校验的切片代替 |
| `saveSession(session, replaceHistory?, toolExecutions?)` | 第三个参数与历史/元信息同事务；稳定记录 ID 幂等追加，拒绝身份冲突 |
| 新增 `readToolExecutions` | 按 Session、Turn、独立 seq 游标在存储层分页，每页 1–200 条；终态清理 checkpoint 不删账本 |
| `TurnCheckpoint.pendingAssistant` | 保留执行前调用快照；不得因最终模型消息尚未落盘而把已启动工具判为未执行 |
| `runtime.listSessions` 返回分页结果 | 消费 `nextCursor`，不要只显示第一页或拿它做全量管理扫描 |
| `runtime.subscribe` 返回 Promise | `await` 订阅并处理建立前连接已关闭；`subscribeAll` 仍同步 |
| Turn 新增 `interrupted` 与 `resumeTurn` | 与完成、取消、失败区分，先恢复/取消再允许新 Turn |
| 可选 `jobs` / `context.runJob` | 显式注入执行器才使用，不能假设原内存任务自动持久化 |

## 6. 修改地图与证据

| 文件 / 目录 | 本次职责 |
| --- | --- |
| `packages/runtime/src/runtime-store.ts`、`runtime.ts` | 按需装载/分页、活动引用保护、空闲回收、Turn checkpoint、执行账本、恢复与外部任务协调 |
| `packages/runtime/src/turn-recovery.ts`、`durable-jobs.ts`、`tool-execution.ts` | 纯恢复判定、任务与执行身份、确定边界、结果校验和分页契约 |
| `packages/agent/src/agent-loop.ts`、`types.ts` | 流式完整调用提前执行、结果复用、排序及等待屏障；提前启动事件携带调用快照 |
| `packages/runtime/src/agent.ts`、`tools.ts`、`protocol.ts`、`index.ts` | 工具上下文能力、错误结果语义、interrupted 状态及公共导出 |
| `packages/local/src/store.ts`、`runtime.ts` | SQLite 独立账本表/原子提交/分页、索引/恢复/有界查询、本地分页汇总与接口迁移 |
| `packages/server/src/server.ts`、`apps/web/client/main.tsx` | HTTP 恢复入口、异步 SSE 订阅、本地继续/停止操作 |
| `packages/runtime/test/*`、`packages/server/test/*` 及 `fixtures/*` | 延迟 Store、显式 GC、真实 SQLite、跨进程退出、重复恢复及失败边界回归 |
| 根 `package.json` | 将新增回归纳入现有 Runtime/Server 测试入口，没有新增依赖 |
| Runtime/Server 现有 CHANGELOG、Server README、开发/嵌入文档及相关 SPEC | 记录公共接口迁移、当前边界、验证与完成状态 |

### 最近一次实现验收记录（2026-10-26）

| 命令 | 结果 |
| --- | --- |
| `npm run test:runtime` | 54 项通过 |
| `npm run test:server` | 230 项通过，含执行账本、流式工具提前执行、共享 Runtime 和本地宿主回归 |
| `node --conditions=source --test packages/runtime/test/durable-jobs.test.ts packages/server/test/tool-execution.test.ts packages/server/test/durable-jobs.test.ts` | 23 项通过，覆盖契约、SQLite 账本和外部任务接管 |
| `packages/agent` 下定向运行 `test/agent.test.ts test/agent-loop.test.ts test/message-replacement.test.ts test/streamed-tool-execution.test.ts` | 58 项通过；命令见流式工具 SPEC |
| `npm run check` | Biome、Runtime/Web 类型及模型数据校验通过 |
| `git diff --check` | 通过 |

这些测试集合有重叠，不能相加当作独立用例总数，也不是本次新增测试数量。覆盖两种保留策略、冷会话、真实 SQLite、显式 GC、工具/MCP、分支/导入导出、压缩、取消、Subagent、HTTP/SSE，以及外部任务丢通知/丢响应/恢复并发与失败写入。新增账本回归包括追加去重、身份冲突、分页隔离、终态/重启保留、删除清理、事务回滚、开始保存失败不执行工具及终态写入失败不绕过账本；流式回归包括执行前快照、等待屏障和真正进程退出。使用假模型与本地端点，没有调用收费模型。

本说明与 HTML 更新至 10 月 26 日执行账本及流式工具阶段，结果引用 `turn-recovery.md`、`streamed-tool-execution.md` 的完成记录与同轮 Server 联合验收。此前 10 月 25 日的 51 / 221 / 19 项是阶段历史，不再作为最新结果；本次仅同步文档，没有重新运行上述业务测试，也不是生产验收。

### 必须保留的限制

- 没有完整的跨实例自动恢复平台；Cloud 归属、授权、调度、通知与生产执行器仍需接入和验收。
- 不保证外部副作用“恰好执行一次”；PIE 不重提已关联任务，不等于 Worker 已具备幂等或内部恢复能力。
- 执行账本不是完整事件溯源或任意步骤重放引擎；缺少提交确认不等于未产生副作用。`durable` 标签不替代执行器、共享存储和租约。
- 流式工具提前执行不提供流中断恢复；Provider 缺少完整调用事件时会回退，未承诺固定延迟收益。
- 持久确认、未保存的 Steer/follow-up 队列、原内存后台 Job 和父子 Turn 级联恢复不在当前范围。
- 普通读取按边界停止不等于所有读取/缓存/事件字节成本有上限；未承诺并发量、RSS 或吞吐的具体提升数字。
- 未构建 Sidecar、未部署、未验收 Electron/Astron 产品实机链路，当前工作区尚未提交或推送。

## 7. 详细设计入口

- [单会话按需装载 SPEC](../specs/session-activation.md)
- [Turn 持久化与安全恢复 SPEC](../specs/turn-recovery.md)
- [历史存储与读取边界 SPEC](../specs/history-storage.md)
- [外部异步任务关联与结果接管 SPEC](../specs/durable-jobs.md)
- [流式工具提前执行 SPEC](../specs/streamed-tool-execution.md)
- [整体演进路线与分工](../specs/remote-loop-evolution.md)
- [Runtime 宿主嵌入契约](../runtime-embedding.md)

**一句话概括：PIE 负责“如何正确执行、保存并重建”，agent-service 负责“谁有权执行、在哪里执行、如何跨实例送达”；本地和云端复用执行语义，不强求相同宿主生命周期。**
