# Changelog

## [Unreleased]

### Breaking Changes

- Require `SessionSnapshot.execution` and include the same lightweight execution view in global events; session deltas can update it without copying history. Preserve native Turn outcomes instead of interpreting settlement as success.
- Require `RuntimeStore.readToolExecutions` and atomic incremental journal appends through the third `saveSession` argument; Cloud adapters must persist execution facts alongside history and Turn metadata.

- Replace `RuntimeStore.loadSessions` with scoped `readSession` and cursor-paged `listSessions`; runtime lists default to 50 entries and return `nextCursor`. Session `subscribe` is asynchronous; `subscribeAll` remains synchronous.
- Add `RuntimeStore.readTurnPath` so recovery can load only the current Turn suffix instead of the full session path.

- Turn status includes `interrupted`; consumers must distinguish an explicitly resumable Turn from completion and cancellation.

- Session subscriptions emit revisioned deltas instead of a complete snapshot on every event; consumers must bootstrap a bounded view and apply increments or reload on gaps. Global subscriptions retain their existing contract.

### Added

- Add scoped `subscribeExecutions` with a lightweight execution baseline and per-session event alignment, without history reads or persistent replay.
- Return structured `RuntimeError.reason` codes and cancellation durability; allow an explicit best-effort local stop after storage failure while keeping ordinary commands rejected.

- Return explicit Turn admission, execution, settlement, cancellation and in-memory steering receipts; deduplicate retries against the current Turn's original or latest request ID.

- Expose Runtime-only `submit`, `steer`, `cancel` and `resume` availability with stable reason codes, including the same execution projection in global snapshot events.

- Persist a pending assistant-call snapshot before streamed tool side effects; clear it when the final response commits and refuse blind recovery if the process stops mid-response. Durable jobs can use the committed snapshot before canonical assistant history is available.

- Record Turn-scoped tool execution facts for inline, delegated and durable tools; retain a cursor-paged journal after Turn completion without enlarging session metadata or event packets. Validate journal/history consistency before external-task recovery and refuse result-only commits after a persistence barrier fails.

- Add opt-in `DurableJobExecutor` and tool-context `runJob`: persist task references before submission, query missing results during original-Turn recovery, and detach on shutdown without cancelling external work. Keep local in-memory jobs unchanged; hosts provide durable execution, ownership and result storage.

- Activate sessions by ID without a startup metadata scan; evict idle Session metadata as well as Agents under `release-after-turn`, while preserving active work and subscriptions.

- Persist the current Turn input boundary and effective prompt; expose shared interrupted-Turn classification and explicit `resumeTurn` without replaying committed tool calls or duplicating user input. Unknown tool outcomes and unsupported queues remain non-resumable.

- Added an advisory reminder after three consecutive calls to the same tool with identical JSON arguments, without blocking execution or imposing a step limit.
- Added optional `sessionRetention: "release-after-turn"` to release idle Agents and working history after durable settlement and reload them through the injected store, while keeping local in-memory reuse by default.

### Fixed

- Pin published execution, Turn and history leaf to their revision, including asynchronous full snapshots; publish cross-session storage failure and preserve revision watermarks across eviction.
- Share availability decisions across all four control entries while distinguishing new operations, idempotent retries, recovery preflight and best-effort cancellation.

- Reject steering during cancellation using the same availability rules as execution projections, including after asynchronous persistence and Agent attachment; keep queued and late input out of the next Turn.

- Cancel external jobs started during model streaming using their checkpointed assistant message, retain matching interrupted history, and settle cancellation persistence before releasing the turn. Late external submissions cannot write into a subsequent turn.

- Withdraw queued or late local-job receipts after `job_output` or `job_kill` delivers a terminal result; batch unread background notifications into one follow-up request while preserving running-job completion delivery.

- Avoid duplicate model wakeups after explicit `job_kill` cancellation of local shell or subagent jobs; keep cancellation results and output readable, including when settlement follows the tool's bounded wait.

- Deliver active-Turn cancellation before queued commands, history reads and persistence; retain cancellation acknowledgement, external-job cleanup and session-lifecycle barriers.

- Classify empty, incomplete and cyclic Turn recovery paths as non-resumable instead of throwing during startup or recovery admission; preserve storage read errors and never start an Agent for invalid history.
