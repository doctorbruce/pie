# Changelog

## [Unreleased]

### Breaking Changes

- Remove the bundled Web UI, its workspace, frontend dependencies, development script and UI tests. Acceptance uses SDK, HTTP/SSE and embedding contracts. Replace `PI_WEB_ORIGIN` and its implicit development-origin allowance with explicit host configuration through `PI_SERVER_ORIGIN`; requests without Origin keep their existing behavior.

- Session SSE bootstraps with the latest 50 messages and then emits revisioned deltas rather than full snapshots; hosts can consume increments and page older history through the shared Runtime helpers. Global `/events` and explicit full-session reads remain unchanged.

### Added

- Expose `GET /sessions/:id/jobs` with the same lightweight, instance-scoped local-job observations as the Runtime SDK; keep Turn settlement distinct from background and descendant completion.

- Bootstrap scoped `/events?sessionId=...` subscriptions with a lightweight execution baseline and align subsequent events for reconnects after silent settlement.

- Recover safe interrupted Turns through SQLite startup classification and the HTTP resume/cancel endpoints; keep the original Turn identity and configuration, and settle already committed final answers without another model call.

- Add an embeddable runtime with asynchronous session storage and host-provided model, tool, skill, MCP and request-recording capabilities; reuse it in the local HTTP service.
- Record complete provider request payloads for each session, including context compaction calls, without changing the prompt or recording authentication headers.

- Add durable same-session conversation trees with upstream `/tree` navigation semantics and HTTP branch selection.
- Accept native message boundaries when forking sessions through Astron.

- Persist per-session `modelOverride`, including explicit null, through the session API, restart, fork, and transfer.
- Add optional user-visible activity descriptions to the native `read`, `edit`, `write`, and `grep` tools.
- Publish UI-only heartbeats for long-running tools and guide bounded, incremental background-job waits.
- Add native `webfetch` adapted from Amio/OpenCode, with text, Markdown and HTML output, permission checks, bounded responses, timeout and cancellation.

### Changed

- Bound local model-request records by age, total bytes, file count and individual size; allow recording to be disabled without changing payload hooks, maintain existing records on startup, and remove session records with their owning sessions.

- Query session metadata on demand and index pending SQLite recovery instead of retaining a startup snapshot; keep the local HTTP session list complete through paged store reads.

- Split shared runtime contracts and orchestration into `@pie/runtime`, and SQLite, local tools and configuration into `@pie/local`; keep `@pie/server` as the local HTTP/SSE and CLI/Sidecar host. Embedded callers must use `@pie/runtime` and explicitly supply agent capabilities.
- Replace runtime history with the compacted working window only after its checkpoint and original messages commit; read full snapshots, exports and fork boundaries from storage.

- Store message tree nodes once in SQLite, with transactional legacy migration and incremental appends.
- Load session metadata at startup and read only the selected history path on demand; retain branch-aware history cursors in the store.

### Fixed

- Retain `model.retry` lifecycle payloads in global and scoped HTTP SSE projections so hosts receive the retry identity, status, attempt, message and next-attempt time.

- Preserve the frozen Turn identity on every global HTTP SSE packet and forward `steerAdmission` on `turn.applied` and `steer.settled`, so hosts observe steering application and keep subsequent content on the correct execution owner.

- Preserve Runtime control rejection reason codes and cancellation durability through HTTP and Local wrappers, including current-Turn retries and explicit best-effort stops after storage failure.

- Forward the same execution projection on every global SSE packet, retain interaction resolution and state-only Agent events, and include execution in session bootstraps.
- Preserve immediate active-Turn cancellation through the Local host instead of waiting for queued reads or management commands; retain shutdown and settlement barriers.

- Bound SQLite history pagination and compaction working-path traversal to the requested page or checkpoint boundaries instead of walking the full parent chain.
- Stop SQLite recovery path traversal at the Turn input and reject missing or off-branch checkpoints without blocking startup or replaying tools.
- Expose webfetch HTTP status, final URL, body size and empty-content boundaries without guessing application success from response text.
- Report shell exit status consistently in foreground results, background notifications and job output without treating ordinary nonzero exits as tool execution errors.
- Read the same public Bilibili video's official mobile page after HTTP 412, with a separate permission check and explicit source attribution.
- Use the same assistant message identity in live events and historical snapshots.
- Preserve imported message identities, attachment metadata and tool results across forks and tree navigation.

- Apply the effective per-turn model instead of retaining the model chosen when the session was created.
- Cancel background-job waits promptly without stopping the job, and release wait timers after settlement.
