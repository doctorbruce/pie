# 固定目标取消与本地控制通道

状态：2026-11-03 Steer 执行归属源码修正与定向验证已完成；宿主联合验收、打包与替换由 Cowork 主流程继续。宿主目标契约见 Cowork `specs/agent-stop-and-continue/`。

现场补验：15:39 Word 任务的 B 引导于受理后约 1.8 秒应用，旧工具已自然完成；原生快照保存 `applied: true`，但 HTTP 全局 SSE 投影遗漏 `turn.applied / steer.settled` 的 `steerAdmission`，且内容/工具包遗漏冻结的 `snapshot.turn`，导致宿主仍等待应用并丢弃归属变化后的内容。最小修正位于 `packages/server/src/server.ts`：所有全局包保留轻量 Turn/执行摘要，两种引导事实透传本条 admission，不改变 Agent loop、队列或 Runtime 生命周期。

补验决策为 T2：`global-stream.test.ts` 新增真实 HTTP/SSE 契约，覆盖有/无会话参数的全局流，从 A 工具结束、B 应用、B 后续内容到 B 终态逐包核对同 revision 的会话事件身份；旧实现先因丢失 `canonical-B` 失败，修后通过。该文件及 `canonical-identity.test.ts` 共 11/11 通过；完整 `npm run check` 与 `git diff --check` 通过。不调用真实模型，本子任务不构建、替换或重启。

当前问题：旧模型或工具还在执行时，Steer 准入立即覆盖 canonical，导致同一工具开始属 A、更新和结束属 B。修正以原生事实为边界：`Turn.steerAdmissions` 顺序保存受理与消费结果；queued 回执 `started/applied: false`，消费用户输入后原子保存实际 owner 与 applied，再发布 `turn.applied`。连续 Steer 的受理前驱与实际消费顺序分别保存；取消、失败和关闭逐条结算未消费输入并清除队列，不自动重放。发布队列入口固定 owner 和载荷，异步投递不读取后续 owner。

本轮验证：faux 工具门闩反例先红，原实现产生 A/B/B 归属，修后 A/A/A。两种队列模式连续应用、消费前重试、取消竞争、模型失败不重放、冷装载遗失队列、HTTP/SQLite 应用事实保留均覆盖。`node --expose-gc --conditions=source --test packages/runtime/test/runtime.test.ts packages/runtime/test/durable-jobs.test.ts packages/server/test/canonical-identity.test.ts packages/server/test/execution-state.test.ts packages/server/test/global-stream.test.ts packages/server/test/local-cancellation.test.ts` 六文件共 82/82 通过；类型约束修正后的七项关键回归通过；随后补充冷装载 native 终态与 admission 终态、revision 一致性回归通过。完整 `npm run check` 和 `git diff --check` 通过。实际变更位于 Runtime 协议/执行及 Runtime、HTTP 测试与对应文档；未修改原版 Agent loop、未增加管理器或持久消息队列。测试决策为 T1+T2，不调用真实模型；本轮未构建、部署或提交。

2026-11-02 历史实现（受理即交接已由上述修正替代）：同一 native Turn 的新 canonical 接替旧 canonical 时，Turn 与回执增加 `replacesCanonicalTurnId`，只保留最近一次真实准入的前驱；`rootCanonicalTurnId` 继续保留首轮。回执在同步排队准入后、后续异步保存前固定身份与当时的受理事实；首轮身份重试不携带后续 handoff。已排队后保存失败仍是结果未知的 503，队列声明 `durable: false`。不增加持久队列、历史幂等表或外部任务清理恢复。

验收：Runtime 公开接口覆盖连续 handoff、首轮重试、取消竞争与受理后保存失败；HTTP/SQLite 验证字段透传和重载保留；运行目标测试和 `npm run check`，不构建、部署或调用真实模型。

实际变更：`packages/runtime/src/{runtime,protocol}.ts` 保存最近前驱并固定准入回执；扩展 Runtime 和 HTTP canonical identity 回归，同步嵌入文档、开发文档、HTTP README 和 Runtime changelog。连续 A → B → C 的前驱回归先失败，再修复通过。测试决策为 T1 + T2，覆盖公共 Runtime 生命周期和真实 HTTP/SQLite 序列化，未增加测试框架。

验证：`node --expose-gc --conditions=source --test packages/runtime/test/runtime.test.ts packages/runtime/test/durable-jobs.test.ts packages/server/test/canonical-identity.test.ts packages/server/test/execution-state.test.ts packages/server/test/global-stream.test.ts packages/server/test/local-cancellation.test.ts` 共 77/77 通过；`npm run check` 全部通过；`git diff --check` 通过。保留既有取消清理和 revision 投影实现，不扩展外部任务取消失败恢复；未构建、部署、提交或调用真实模型，桌面联合验收仍由宿主变更完成后执行。

Canonical identity 接入已完成并通过公开 Runtime 与 HTTP/SQLite 回归。ACP 连接复用数字 requestId 时，不同 canonical Turn 得到不同 native Turn；已有取消控制通道及终态 readiness 行为保留。

`TurnInput.canonicalTurnId` 为可选的宿主身份，校验非空、最多 256 字符后原样保存到 Turn、snapshot.turn 和 receipt。有 canonical 时以它优先去重，同 canonical 必须绑定同一原 requestId，否则返回 409；不同 canonical 不按相同 requestId 复用旧轮。未提供 canonical 时继续兼容原 requestId 去重。

Steer 保持物理 Turn ID，更新当前 canonical/request 关联，并保留 `rootCanonicalTurnId/rootRequestId` 供首轮重试；回执返回本次请求对应的 canonical。关联保存在现有 Turn 元信息中，不新增产品状态表，不扩大为历史全部 Turn 的幂等索引。Steer 队列仍只承诺当前进程受理，不承诺跨进程恢复队列。

验收使用 faux Runtime 公开接口覆盖数字 requestId 跨轮复用、同身份重试、快照/事件/存储/回执和身份冲突；补充 Local SQLite/HTTP 契约检查，运行完整 `npm run check` 和最小 runtime/server 回归，最后只构建 Windows Bun sidecar 与许可文件。

Local 的普通 commands 队列可能被助手配置、历史或其他 operation 占用；活动取消必须直接进入 Runtime 的固定 turnId 校验与幂等入口。保留 Runtime 的取消持久化、关闭屏障与 execution.actions readiness，不由 Local 推断已停止。关闭期间拒绝新控制。

范围：Local 调度边界、native 目标/幂等/readiness 回归。终态发布时若 runPromise 尚未释放，execution.actions.submit.available 保持 false；释放后追加 snapshot，明确投影准入。Windows Bun sidecar 已构建，并由 Cowork 主流程替换 Cowork3 与 AppData 对应目标，部署与散列见宿主实施记录；桌面验收由用户进行。

验证：真实 Local 装配与 SQLite，阻塞普通命令后取消仍送达；重复固定目标和旧目标不得影响下一轮。最终 Runtime、HTTP/SQLite、Local 控制、全局事件流与 durable jobs 定向测试共 56 项通过，npm run check 与 Windows Bun 构建通过。另以实际部署 exe 的 faux HTTP 会话验证跨轮 requestId 复用、canonical 幂等与 409 冲突。源码与 HTTP 冒烟不等同真实模型或桌面按钮验收。

2026-10-30 合并范围：接入远端固定 revision 的执行投影、统一控制原因码和 scoped execution baseline，保留本地 canonical 绑定及清理结束后的准入屏障。Steer 身份持久化后发布新 snapshot，避免同 revision 的快照仍携带旧 canonical；终态与 ready snapshot 分别验证。终态重复取消沿用远端无操作回执，`accepted / cancellationRequested / durable` 均为 false。本次不构建或部署 Sidecar。

本次验证：完整 `npm run check` 通过；`node --expose-gc --conditions=source --test packages/runtime/test/runtime.test.ts packages/runtime/test/durable-jobs.test.ts packages/server/test/canonical-identity.test.ts packages/server/test/local-cancellation.test.ts packages/server/test/execution-state.test.ts packages/server/test/global-stream.test.ts` 共 71 项全部通过，包含 GC 引用回收检查。关键文件为 `packages/runtime/src/runtime.ts` 及对应 Runtime、执行投影、全局流和 Local 取消测试；未新增功能或扩大范围。未执行本次 Sidecar 构建、部署或桌面验收。
