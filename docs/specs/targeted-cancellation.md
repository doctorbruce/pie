# 固定目标取消与本地控制通道

状态：源码实现与定向验证已完成，包含 2026-10-30 远端合并验证。宿主目标契约见 Cowork `specs/agent-stop-and-continue/`。

Canonical identity 接入已完成并通过公开 Runtime 与 HTTP/SQLite 回归。ACP 连接复用数字 requestId 时，不同 canonical Turn 得到不同 native Turn；已有取消控制通道及终态 readiness 行为保留。

`TurnInput.canonicalTurnId` 为可选的宿主身份，校验非空、最多 256 字符后原样保存到 Turn、snapshot.turn 和 receipt。有 canonical 时以它优先去重，同 canonical 必须绑定同一原 requestId，否则返回 409；不同 canonical 不按相同 requestId 复用旧轮。未提供 canonical 时继续兼容原 requestId 去重。

Steer 保持物理 Turn ID，更新当前 canonical/request 关联，并保留 `rootCanonicalTurnId/rootRequestId` 供首轮重试；回执返回本次请求对应的 canonical。关联保存在现有 Turn 元信息中，不新增产品状态表，不扩大为历史全部 Turn 的幂等索引。Steer 队列仍只承诺当前进程受理，不承诺跨进程恢复队列。

验收使用 faux Runtime 公开接口覆盖数字 requestId 跨轮复用、同身份重试、快照/事件/存储/回执和身份冲突；补充 Local SQLite/HTTP 契约检查，运行完整 `npm run check` 和最小 runtime/server 回归，最后只构建 Windows Bun sidecar 与许可文件。

Local 的普通 commands 队列可能被助手配置、历史或其他 operation 占用；活动取消必须直接进入 Runtime 的固定 turnId 校验与幂等入口。保留 Runtime 的取消持久化、关闭屏障与 execution.actions readiness，不由 Local 推断已停止。关闭期间拒绝新控制。

范围：Local 调度边界、native 目标/幂等/readiness 回归。终态发布时若 runPromise 尚未释放，execution.actions.submit.available 保持 false；释放后追加 snapshot，明确投影准入。Windows Bun sidecar 已构建，并由 Cowork 主流程替换 Cowork3 与 AppData 对应目标，部署与散列见宿主实施记录；桌面验收由用户进行。

验证：真实 Local 装配与 SQLite，阻塞普通命令后取消仍送达；重复固定目标和旧目标不得影响下一轮。最终 Runtime、HTTP/SQLite、Local 控制、全局事件流与 durable jobs 定向测试共 56 项通过，npm run check 与 Windows Bun 构建通过。另以实际部署 exe 的 faux HTTP 会话验证跨轮 requestId 复用、canonical 幂等与 409 冲突。源码与 HTTP 冒烟不等同真实模型或桌面按钮验收。

2026-10-30 合并范围：接入远端固定 revision 的执行投影、统一控制原因码和 scoped execution baseline，保留本地 canonical 绑定及清理结束后的准入屏障。Steer 身份持久化后发布新 snapshot，避免同 revision 的快照仍携带旧 canonical；终态与 ready snapshot 分别验证。终态重复取消沿用远端无操作回执，`accepted / cancellationRequested / durable` 均为 false。本次不构建或部署 Sidecar。

本次验证：完整 `npm run check` 通过；`node --expose-gc --conditions=source --test packages/runtime/test/runtime.test.ts packages/runtime/test/durable-jobs.test.ts packages/server/test/canonical-identity.test.ts packages/server/test/local-cancellation.test.ts packages/server/test/execution-state.test.ts packages/server/test/global-stream.test.ts` 共 71 项全部通过，包含 GC 引用回收检查。关键文件为 `packages/runtime/src/runtime.ts` 及对应 Runtime、执行投影、全局流和 Local 取消测试；未新增功能或扩大范围。未执行本次 Sidecar 构建、部署或桌面验收。
