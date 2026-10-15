# Changelog

## [Unreleased]

### Added

- Add an embeddable runtime with asynchronous session storage and host-provided model, tool, skill, MCP and request-recording capabilities; reuse it in the local HTTP service.
- Record complete provider request payloads for each session, including context compaction calls, without changing the prompt or recording authentication headers.

- Add durable same-session conversation trees with upstream `/tree` navigation semantics and Web branch selection.
- Accept native message boundaries when forking sessions through Astron.

- Persist per-session `modelOverride`, including explicit null, through the session API, restart, fork, and transfer.
- Add optional user-visible activity descriptions to the native `read`, `edit`, `write`, and `grep` tools.
- Publish UI-only heartbeats for long-running tools and guide bounded, incremental background-job waits.
- Add native `webfetch` adapted from Amio/OpenCode, with text, Markdown and HTML output, permission checks, bounded responses, timeout and cancellation.

### Changed

- Replace runtime history with the compacted working window only after its checkpoint and original messages commit; read full snapshots, exports and fork boundaries from storage.

- Store message tree nodes once in SQLite, with transactional legacy migration and incremental appends.
- Load session metadata at startup and read only the selected history path on demand; retain branch-aware history cursors in the store.

### Fixed

- Read the same public Bilibili video's official mobile page after HTTP 412, with a separate permission check and explicit source attribution.
- Use the same assistant message identity in live events and historical snapshots.
- Preserve imported message identities, attachment metadata and tool results across forks and tree navigation.

- Apply the effective per-turn model instead of retaining the model chosen when the session was created.
- Cancel background-job waits promptly without stopping the job, and release wait timers after settlement.
