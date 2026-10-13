# Changelog

## [Unreleased]

### Added

- Persist per-session `modelOverride`, including explicit null, through the session API, restart, fork, and transfer.
- Add optional user-visible activity descriptions to the native `read`, `edit`, `write`, and `grep` tools.
- Publish UI-only heartbeats for long-running tools and guide bounded, incremental background-job waits.
- Add native `webfetch` adapted from Amio/OpenCode, with text, Markdown and HTML output, permission checks, bounded responses, timeout and cancellation.

### Fixed

- Apply the effective per-turn model instead of retaining the model chosen when the session was created.
- Cancel background-job waits promptly without stopping the job, and release wait timers after settlement.
