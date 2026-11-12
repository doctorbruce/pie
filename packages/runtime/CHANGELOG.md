# Changelog

## [Unreleased]

### Changed

- Steering preempts model generation while preserving started tools and their execution owner until settlement. Finish mutating context preparation before applying new input; admission receipts, Turn identity and event contracts remain unchanged.

- Project image history with a configurable `AgentRuntimeConfig.maxHistoryImageBytes` target, defaulting to 16 MiB of encoded image data. Omit older tool images before older user images, preserve the latest real user images and original stored history, and include budgeted images with source markers in vision summaries.

- Collapse Worker model-side sending and waiting into one `communicate` tool; keep `send`/`wait` internals and legacy history parsing compatible.

- Return synchronous Worker waits to the model in at most 30-second slices or when new input is available, preserving the pending request and atomic reply consumption. Explicit `timeout_ms` limits one wait call; continuing the wait starts a new interval. Keep asynchronous yielding and host `workerWaitMode` behavior.

- Guide coordinating assistants to report meaningful progress during long work, and Workers to send causal stage updates; keep tool activity heartbeats out of model history.

- Wait for configured Host Runtime MCP prewarm during runtime registration, reusing the connection readiness promise on the first Turn.
- Let the model finish its normal user-facing response after registering a Worker wait, then yield the Turn; keep replies received during finalization queued for a new Turn in the same Session.
- Publish the existing skill index and optional host `capabilityCatalog` as persisted, hidden user context only on first use or change. Append complete replacements, including empty lists, preserve system/history prefixes, and republish after compaction removes the list.

### Removed

- Stop injecting tool discovery guidance and catalogs into model system prompts; keep generic discovery and availability guidance in `tool_search`, with on-demand tool schemas and MCP service guidance in search results.

### Breaking Changes

- Require `SessionSnapshot.execution` and include the same lightweight execution view in global events; session deltas can update it without copying history. Preserve native Turn outcomes instead of interpreting settlement as success.
- Require `RuntimeStore.readToolExecutions` and atomic incremental journal appends through the third `saveSession` argument; Cloud adapters must persist execution facts alongside history and Turn metadata.

- Replace `RuntimeStore.loadSessions` with scoped `readSession` and cursor-paged `listSessions`; runtime lists default to 50 entries and return `nextCursor`. Session `subscribe` is asynchronous; `subscribeAll` remains synchronous.
- Add `RuntimeStore.readTurnPath` so recovery can load only the current Turn suffix instead of the full session path.

- Turn status includes `interrupted`; consumers must distinguish an explicitly resumable Turn from completion and cancellation.

- Session subscriptions emit revisioned deltas instead of a complete snapshot on every event; consumers must bootstrap a bounded view and apply increments or reload on gaps. Global subscriptions retain their existing contract.

### Added

- Add `setSessionWorkspace` to persist an idle root session's directory before subsequent direct or Worker turns. Preserve history, reset the idle Agent after saving, restore the original path on save failure, and allow same-path verification while busy.

- Bind Local Assistant lifecycle updates to a stable logical Worker identity while keeping Worker Session creation lazy per work item.

- Preserve a safe `metadata.workerCommunication` envelope on incoming Worker messages and display events, so hosts can distinguish peer messages from human input without changing model roles or message bodies.

- Add independent host `workerTargets` with omission-only fallback to legacy subagents, explicit empty-target denial and send-time authorization checks; preserve valid causal replies without reverse proactive permission.

- Add opt-in Worker `send_message` and `wait_message` tools in place of task, with trusted sender identities, authorized targets, causal replies, durable waits and cancellation, structured Turn yields and atomic input/history consumption between model calls.

- Add opt-in logical Workers, durable work/session/message/delivery facts and a deterministic `WorkerScheduler`; queue input per Session while different Sessions execute independently, preserve creation and dispatch identities, and accept a host product-session binding during session creation. Optional `waitForTurn` observers capture one Turn's wait and settlement boundaries independently of asynchronous snapshot reads.

- Add host `cancelBackgroundJob` for directly owned local Shell/Task jobs, with cleanup acknowledgement, suppressed wakeups and access during storage failure; require instance and per-execution identities to reject stale stops when a Task reuses its job ID.

- Add `archiveSession` and persisted session `archived` state; public session lists hide archived sessions unless `includeArchived` is true. Stores exclude archived sessions before pagination when `SessionListOptions.includeArchived` is false.

- Add optional durable `creationKey` for session creation and `getSessionCreation` reconciliation; persist creation identity atomically with the session, reject conflicting retries, and retain keys after deletion. Stores opt in through `readSessionCreation` and the fourth `saveSession` argument.

- Add opt-in remembered native `bash` and `external_directory` approvals through `InteractionReply.remember`; persist exact permission scopes in the execution session across turns and restarts without inheriting them into new, forked or related sessions.

- Expose `listBackgroundJobs` with instance-scoped, directly owned Shell/Task summaries without history, output or arbitrary details; distinguish Turn settlement from background work and reject parent deletion while a child still owns active local jobs.

- Add native `skill_search` for searching or listing the current runtime's mounted skill bindings without reading files or recording skill loads; return exact IDs for `skill`, honor per-turn availability, and guide discovery before filesystem scans.

- Accept per-turn `toolAvailability` to restrict actual tools, deferred discovery and MCP tools without expanding the assistant's configured scope; preserve the current Turn boundary across steering, recovery and child assistants.

- Accept optional host `canonicalTurnId`, persist and echo it in Turn snapshots and receipts, and prioritize its request binding for submit retries. Steering preserves the native Turn ID and original canonical binding while updating the current binding; conflicting request identities return 409.

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

### Changed

- Refresh mounted skills between model calls in the same Turn, including skill discovery, loading and prompt metadata; preserve tool restrictions, loaded deferred tools, MCP leases and durable Turn context without rebuilding the Agent.

- List currently available, unloaded deferred tools by ID and a brief summary in `tool_search.description`, refreshing the list before each model request without changing the system prompt.

### Fixed

- Recover once through compaction from HTTP or streamed 413 payload errors, preserving current user images and ending the Turn if recovery fails again.

- Publish saved `communicate` receipts before waiting so hosts can render an active Task; release synchronous waits on known target execution failure while preserving an already delivered response.

- Persist per-Turn Worker input cancellation cutoffs so queued messages stay cancelled after restart without swallowing later requests; recheck stopped sender identities and work assignments before saving model messages.

- Provide explicit causal response instructions for incoming Worker requests and questions, including the exact sender, message ID and response kind, so models can return results instead of leaving them only in the target Session. Avoid acknowledgement loops for responses and progress messages.

- Cancel local Shell/Task jobs belonging to an explicitly stopped Turn, including descendant background work after a Task returns; wait for their cleanup before Turn settlement and suppress cancellation wakeups. Preserve jobs from normally completed earlier Turns and other sessions.

- Publish ordinary model retry attempts and final outcomes through `model.retry` with a stable per-call identity, independently of compaction, so hosts can show progress and stop silent waiting.
- Retry explicit `Upstream API error: 530` gateway failures wrapped in a successful HTTP response without treating unrelated numeric text as a retryable error.

- Separate queued steering admission from applied execution ownership through `steerAdmissions`, `turn.applied` and `steer.settled`; keep old model/tool events on their original owner until input consumption, preserve ordered admissions and retries, settle abandoned inputs without replay, and capture publication payloads before asynchronous delivery. Keep post-admission save failures observable without claiming durable steering queues.

- Retry transient model failures before forwarding response content or tool events, including empty-body HTTP 503s; use five retries with interruptible, jittered exponential backoff capped at 30 seconds, without replaying completed tools or layering SDK retries.

- Pin published execution, Turn and history leaf to their revision, including asynchronous full snapshots; publish cross-session storage failure and preserve revision watermarks across eviction.
- Share availability decisions across all four control entries while distinguishing new operations, idempotent retries, recovery preflight and best-effort cancellation.

- Reject steering during cancellation using the same availability rules as execution projections, including after asynchronous persistence and Agent attachment; keep queued and late input out of the next Turn.

- Cancel external jobs started during model streaming using their checkpointed assistant message, retain matching interrupted history, and settle cancellation persistence before releasing the turn. Late external submissions cannot write into a subsequent turn.

- Withdraw queued or late local-job receipts after `job_output` or `job_kill` delivers a terminal result; batch unread background notifications into one follow-up request while preserving running-job completion delivery.

- Avoid duplicate model wakeups after explicit `job_kill` cancellation of local shell or subagent jobs; keep cancellation results and output readable, including when settlement follows the tool's bounded wait.

- Deliver active-Turn cancellation before queued commands, history reads and persistence; retain cancellation acknowledgement, external-job cleanup and session-lifecycle barriers.

- Classify empty, incomplete and cyclic Turn recovery paths as non-resumable instead of throwing during startup or recovery admission; preserve storage read errors and never start an Agent for invalid history.
