# Turn 持久化与安全恢复

状态：已完成（PIE 侧第一阶段与统一 ToolExecution 执行账本；Cloud 适配和联合故障验收待后续）。日期：2026-10-26。

## 问题与目标

进程重启后能读取 Session，不等于能继续尚未完成的执行。此前 SQLite 和 Cloud 都把中断 Turn 修复为失败；Agent、Promise、确认回调和后台任务不能从历史直接复活。

以 Turn 作为最小恢复任务，沿用原 `turnId`、`requestId` 和用户消息，在已经提交的消息边界重建 Agent。两端共用恢复判定与执行入口；不创建另一套云端 Loop。总体路线延续 [远端 Loop 演进](remote-loop-evolution.md)，不替代按会话轻量装载阶段。

例如：用户输入已落盘 → 模型提出工具调用 → 工具结果落盘 → 服务崩溃。恢复时从工具结果继续请求模型，不再插入用户输入，也不重复执行工具。若工具调用已落盘而结果未提交，不能推断工具没有执行，必须阻断，不自动重放。

恢复所需的执行事实统一归属于 Turn 下的 `ToolExecution`，不把 Job 或 Task 设计成与 Turn、Tool 平级的领域对象。同步工具调用、子 Agent 调用和可跨进程接管的外部异步调用只是不同执行模式；后者仍可由宿主提供 `DurableJobExecutor`，但 Job 只是执行器适配和持久关联的名称。

## 本次范围：第一阶段

- 在现有 Session 元数据中持久化当前 Turn 的版本化执行 checkpoint：原 Turn 身份、输入节点、实际使用的完整 system prompt。运行配置、助手版本、模型和压缩 checkpoint 继续使用已有持久字段，不保存凭据。
- 共享 Runtime 提供纯恢复判定与显式 `resumeTurn`。宿主先确认旧执行者已停止，再把安全的中断 Turn 标为 `interrupted`；恢复仍使用原 Turn，不调用 `submitTurn`。
- 支持用户输入已提交、整批工具结果已提交后的继续执行；最终 Assistant 已提交而 Turn 尚未结算时，仅补齐终态，不重新调用模型。
- SQLite 在显式设置 `PI_TURN_RECOVERY=manual` 后使用共享启动判定，本地通过 SDK / HTTP 恢复或取消，不在启动时静默执行。默认仍按原失败修复流程处理，避免尚未接入恢复接口的 Astron 宿主遇到 `interrupted` 后无法继续提交；正常启动、SQLite、内存保留策略不变。
- 缺少 checkpoint 的旧记录、缺失工具结果、未持久化队列、Subagent 和后台执行不自动续跑，保留现有失败修复和未知结果提示。明确失败或取消的 Turn 不复活。
- 错误 Turn ID、并发恢复、恢复准入写入失败必须拒绝。恢复前校验历史边界，使用原已应用配置与动态提示词，不应用下一轮助手配置。
- 本次收尾修复：SQLite 从叶子反向读取到 Turn 输入即停止，不再先遍历全部祖先；输入缺失或属于其他分支时返回不可恢复路径，无效检查点不阻塞服务启动。共享判定将收到的空路径、断链和循环判为失败。补充实际递归步数、SQLite 重启与 Runtime 恢复拒绝回归；不扩展复杂续跑或资源配额。

## 第二阶段：统一 ToolExecution 执行账本

- 在 `packages/runtime` 定义 Turn 下的最小执行事实链：`started`、`submission_intent`、`submitted`、`completed`、`failed` 和 `recovery_required`。每条记录关联 `sessionId`、`turnId`、`toolCallId`、工具名、稳定执行 ID 和时间；外部执行关联现有任务 ID，该 ID 继续作为执行器幂等键。结果正文沿用历史节点，不在账本再存一份。
- 让 Turn checkpoint 继续负责恢复准入和上下文边界，让执行账本负责回答“工具是否已提交、结果是否明确、是否可以重试或接管”。不以账本替代历史节点、工作上下文或压缩 checkpoint。
- 统一三类执行模式：`inline`、`delegated` 和 `durable`。内置 Task 记为 `delegated`；外部工具可声明 `toolExecutionMode`，调用 `runJob` 后按真实关联记为 `durable`，但单纯声明不会赋予恢复能力。本地 Shell、后台任务和父子 Turn 仍不自动迁移。
- 恢复按最后一个确定边界推进：先核对账本、原始调用、已提交结果和 checkpoint 任务身份，再查询原外部 ID；结果明确后原子提交结果和终态账本。本阶段恢复不重新调用 `submit`。缺少 `submitted` 不能证明没产生副作用：提交前崩溃和响应丢失都可能只有 `submission_intent`；missing/unknown 继续阻断，不能盲目重提。
- 账本是 Store 的独立追加记录，不放进 Session 元信息或 Turn checkpoint 数组。`saveSession` 的第三个参数提交本次增量记录，与历史及 Turn 元信息同一事务；重复事实按稳定记录 ID 去重，身份冲突拒绝。SQLite 使用独立表，Cloud 须提供等价实现。
- `readToolExecutions(sessionId, { turnId, limit, afterSeq? })` 按当前会话和 Turn 游标分页，每页 1–200 条。账本 seq 与历史 seq、事件 revision 分开；终态清除 checkpoint、下一轮执行和重启不删除账本，删除会话才级联删除。常规列表、快照、SSE 和空闲 Session 不装载完整账本。
- 本阶段不记录流式 token、Promise 调用栈或每个内部循环步骤，不引入完整 Event Sourcing，也不要求所有本地工具变成可迁移任务。已有 `DurableJobExecutor` 契约作为云端宿主适配层继续使用，具体存储、租约、通知和执行器由宿主负责。

## 不做的事与宿主责任

- 不恢复流式 token 或 CPU/Promise 栈；未提交的模型输出可能重新生成。
- 恢复判定只读取当前 Turn 输入节点到叶子的路径后缀；如果 checkpoint 无效或需要生成未知工具结果，才回退读取完整当前路径。按 ID 元信息装载由 [单会话装载](session-activation.md) 交付；当前 Turn 本身仍不设置消息数量上限。
- 不实现部分并行工具批次重放、未知结果人工认领、持久确认队列、原内存后台任务接管或父子 Turn 级联恢复。后续增加的外部任务查询与结果接管见 [外部任务 SPEC](durable-jobs.md)，不把错误工具结果当作成功事实。
- 不把 Job、Task 或 Subagent 拆成独立的顶层恢复模型；它们的跨进程接管统一通过 Turn 下的 `ToolExecution` 表达。现有外部任务执行器契约仍由 [外部任务 SPEC](durable-jobs.md) 描述。
- 不实现 Redis/MySQL、任务队列或新的工作流框架，也不修改 Cloud 工作树。本阶段先交付共享能力与本地可验证闭环；Cloud 复制包和现有恢复器仍需增量适配。
- Cloud 在调用共享恢复前，必须取得有效 owner/租约并阻断旧 owner 写入，核对授权、执行器和工具账本。历史上存在 toolResult 不代表远端后台工作已结束；不满足条件不得标记可恢复。
- 不承诺外部副作用恰好执行一次。工具幂等、远端结果查询及旧执行者终止由工具层和宿主保证。

## 实现思路

当前 Turn checkpoint 与用户消息、Session 配置在同一 `saveSession` 事务提交；后续继续使用已有 `message_end` 的持久化屏障。恢复入口通过 `RuntimeStore.readTurnPath` 读取 checkpoint 输入到当前叶子的独立路径后缀，避免把 Turn 之前的长历史加载进恢复判定；后缀首节点保留原 ID 但作为局部根节点处理。恢复判定只接受 checkpoint 对应的有效输入和完整工具配对；活动队列、子任务及后台通知路径显式标记为本阶段不可恢复。

执行账本作为 checkpoint 的补充事实源：复用 Agent 会等待的工具事件，工具调用开始前提交身份，外部提交前原子保存关联与 `submission_intent`，确认提交成功后追加 `submitted`。工具终态取自后处理后的 `toolResult`，和结果正文原子提交；执行函数返回不等于结果已提交，不能提前写 `completed`。恢复时先读取 Turn 后缀和分页账本，再查询宿主执行器；结果、账本与恢复准入一并落库后才重新进入模型 Loop。存储屏障一旦失败，本实例不在收尾时绕过账本另存结果，须重启并核对持久状态。

`recovery_required` 是账本事实，不新增公开 Turn 状态，也不表示任务已成功或已撤销副作用。查询异常、提交响应丢失、取消结果未知或本地启动修复未知调用时记录该边界；明确的工具失败仍进入原 Loop。进程突然退出可能只留下 `started` / `submission_intent` / `submitted`，恢复必须保守核对，不能要求一定存在中断记录。

`interrupted` 表示旧执行已经停止、历史足够继续，但尚未取得本次执行准入。`resumeTurn` 再次检查原 Turn 和历史，恢复原模型与 prompt，将 Turn 写回 `running` 后才执行；取消则直接可靠结算，不构造 Agent。切换/导入历史或开始下一 Turn 时不能携带旧 checkpoint。

## 验收

- 相同 Turn ID 恢复，不重复用户消息；原 prompt、模型和配置不被下一轮更新覆盖。
- 已提交工具结果不重复执行；缺失结果/无 checkpoint/异步路径不恢复。
- 最终 Assistant 已提交只补结算；失败、取消和错误 Turn ID 不复活。
- 恢复并发、准入失败和取消可恢复 Turn 有定向回归。
- 使用注入 Store 和真实 SQLite/HTTP 验证恢复闭环；运行最小定向测试、`npm run test:runtime`、`npm run test:server` 与 `npm run check`。不调用真实模型、不构建发行包。
- 长历史恢复只读取 Turn 后缀；无效 checkpoint 和安全失败修复仍能回退完整路径。
- 通过 SQLite 递归节点计数证明旧历史增长不增加有效 Turn 的回溯步数；检查点缺失或位于其他分支时，启动仍成功，未知工具结果只补写一次且不执行工具，显式恢复返回 409 而非路径异常。
- 执行账本验收：三种模式均按原工具调用使用稳定身份；工具后处理确定结果后才提交终态；提交前退出、响应丢失、通知丢失和并发恢复不重复提交。缺少历史结果却存在终态账本时拒绝恢复，不创建 Agent 或查询执行器。
- 使用真实 SQLite 验证增量追加、幂等去重、身份冲突、事务回滚、Turn/会话隔离、分页、终态保留及删除清理；Runtime 验证开始落库失败不执行工具，终态落库失败不产生后续“仅结果”提交。
- 本地默认 `retain`、SQLite 工具行为和已有 Promise 执行方式不变；新增账本只作为恢复与审计事实，不要求本地常驻 Agent 改成按 Turn 重建。

## 实施记录

- 2026-10-24 第一阶段完成：`packages/runtime/src/runtime-store.ts` 增加版本化 Turn checkpoint；`turn-recovery.ts` 提供共享分类；`runtime.ts` 原子保存输入与有效 prompt，提供 `resumeTurn`，持久化取消意图，并阻断队列、子任务和后台执行的恢复。终态清除执行 checkpoint，不把它当作上下文压缩摘要。
- `packages/local/src/store.ts` 增加显式恢复模式；`packages/server/src/server.ts` 增加 `POST /sessions/:id/resume`；中断状态与恢复 / 取消操作由宿主消费共享契约，自带测试 UI 已移除（见 [删除 SPEC](remove-bundled-web.md)）。嵌入文档、开发文档和已有 changelog 已同步。
- 验证：`node --conditions=source --test packages/runtime/test/turn-recovery.test.ts packages/server/test/turn-recovery.test.ts` 初始 15 项通过；最终 `npm run test:runtime` 40 项、`npm run test:server` 182 项通过，包含新增 17 项恢复回归。真实 SQLite 子进程在已提交输入、工具调用、工具结果、最终回答及取消意图边界直接退出，再通过 Runtime / HTTP 重建；已提交文件工具不重复执行，节点 ID 和原 Turn/request ID 保留。
- 模型 / 提示词 / 多模态额外回归：`node --conditions=source --test packages/server/test/agent.test.ts packages/server/test/model-override.test.ts packages/server/test/multimodal-input.test.ts packages/server/test/provider-composer.test.ts` 12 项通过。`npm run check` 和 `git diff --check` 通过；仅使用替身及本地模拟端点，无收费模型调用。
- 相对初稿的调整：核对 Astron Pie adapter 后将本地安全分类改为 `PI_TURN_RECOVERY=manual` 显式启用。默认仍中断即失败，避免旧宿主尚无恢复入口却被禁止下一轮；Cloud 不读取此本地开关。另补充取消意图持久化和后台工具结果标记校验，避免把它们当作普通安全继续点。
- 2026-10-24 第一阶段收尾完成：新增 `RuntimeStore.readTurnPath`，Runtime 恢复与 SQLite 启动恢复优先读取当前 Turn 后缀；无效 checkpoint 或需要补写未知工具结果时回退完整路径。补充内存 Store、SQLite 和 Runtime 回归。
- 验证：`npm run check`、`npm run test:runtime`（47 项）和 `npm run test:server`（193 项）通过；新增定向恢复 / SQLite 测试 22 项通过，未调用真实模型，未构建发行包。
- 2026-10-24 恢复边界修复完成：`packages/local/src/store.ts` 使用输入 seq 限制递归、核对输入确实位于目标分支后才解码正文；`packages/runtime/src/turn-recovery.ts` 将路径校验异常收敛为失败判定。输入缺失或属于其他分支时 SQLite 启动正常补写未知结果且不重放工具；显式恢复返回 409，不创建 Agent、不改写持久状态。存储读取错误仍向调用方传播，既有本地默认策略不变。
- 新增 7 项回归：初轮复现祖先多读和路径异常共 5 项失败；修复后恢复 / SQLite / HTTP 定向 39 项通过，当前整体刷新后的 `npm run test:runtime` 48 项、`npm run test:server` 202 项、`npm run check` 和 `git diff --check` 通过。固定当前 Turn 为 5 个节点，旧历史为 20 / 2000 条时均只递归读取 4 个祖先；1000 条旧正文故意损坏时仍能完成启动分类，持久父指针、ID 和 seq 不变。测试只使用替身与本地端点。
- 未完成：Cloud 五包增量同步及恢复器 / Store / 事件消费者接入、租约与工具账本联合故障验收、部分工具批次及未知结果认领、持久确认、原内存后台和父子任务接管。外部任务的持久关联与查询接管单独延续 [外部任务 SPEC](durable-jobs.md)。本次未修改 Cloud / Amio，未构建或部署 Sidecar，未进行 Electron / Astron 产品 UI 实机验收。
- 本阶段结论：正常恢复判定的遍历和正文读取已限制在当前 Turn；失败修复仍可能读取完整路径，当前 Turn 本身仍无条数或字节上限，继续执行的模型上下文仍由 `readWorkingPath` 恢复。资源成本专项验收和复杂续跑不属于本次修复；Cloud 适配由同事后续实现共享契约。
- 2026-10-26 设计调整：确认 Job 不是 PIE 的顶层恢复对象，而是可跨进程接管的 `durable` ToolExecution 适配。Turn checkpoint 负责恢复上下文和准入，后续统一执行账本负责记录工具调用的确定边界；Task、Subagent 与其他工具按是否跨进程接管选择执行模式。实现和 Cloud 联合验收尚未开始。

### 2026-10-26 统一执行账本：PIE 侧已完成

- `packages/runtime/src/tool-execution.ts` 定义执行模式、确定边界、稳定身份和分页契约；`runtime-store.ts` 为 `saveSession` 增加增量账本参数及 `readToolExecutions`。`tools.ts` 允许声明执行模式，`index.ts` 导出共享类型，`packages/local/src/runtime.ts` 转发读取入口。
- `packages/runtime/src/runtime.ts` 在工具副作用开始前持久化 `started`；外部提交前原子保存关联与 `submission_intent`，收到确认才保存 `submitted`。后处理后的工具结果与 `completed` / `failed` 同事务落盘；写入屏障失败后不再通过收尾绕过账本单独保存结果。后台完成未知、取消未知及外部等待异常记为 `recovery_required`，不伪造成功或撤销事实。
- 恢复先核对当前 Turn 的账本、历史结果和原任务身份；发现终态账本缺少配套结果时，在查询执行器或创建 Agent 前拒绝。明确的远端结果与终态账本、恢复准入原子提交后才继续模型；缺失、未知和响应丢失均不自动重提任务。同工作树的流式工具提前执行通过 pendingAssistant 保留开始前调用快照，未提交的模型响应仍不盲目恢复。
- `packages/local/src/store.ts` 增加独立 SQLite 表与 Turn/seq 索引，支持追加去重、身份冲突拒绝、事务回滚和 1–200 条游标分页。终态清理 checkpoint、下一 Turn 与重启保留账本，删除 Session 才级联删除；不把完整账本放入会话、快照或 SSE。本地默认保留策略和显式恢复开关不变。
- 验证：`node --conditions=source --test packages/runtime/test/durable-jobs.test.ts packages/server/test/tool-execution.test.ts packages/server/test/durable-jobs.test.ts` 23 项通过；`npm run test:runtime` 54 项、最终 `npm run test:server` 230 项通过，`npm run check` 与 `git diff --check` 通过。完整回归包含同工作树的流式工具提前执行改动，并非本阶段新增测试数量；均使用替身、真实 SQLite 或本地模拟端点，无真实模型调用。
- 相对初稿：使用 Store 独立追加事实和现有 Agent 持久化事件，而非在 checkpoint 累积账本、包装全部工具或建立完整事件溯源框架；不把声明 `durable` 等同于具备接管能力，也不依据缺少提交确认自动重试。
- 未完成与交付边界：Cloud 须以增量合并适配原子 `saveSession`、分页读取、外部执行器和租约，完成跨实例故障验收；未实现原内存 Shell/后台/父子任务迁移和未知副作用认领。本次未修改 Cloud / Amio，未构建、部署、提交或推送；嵌入迁移说明见 `docs/runtime-embedding.md`，外部执行器边界见 `docs/specs/durable-jobs.md`。
