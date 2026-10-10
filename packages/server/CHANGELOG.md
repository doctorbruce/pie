# Changelog

## [Unreleased]

### Added

- Persist per-session `modelOverride`, including explicit null, through the session API, restart, fork, and transfer.
- Add optional user-visible activity descriptions to the native `read`, `edit`, `write`, and `grep` tools.

### Fixed

- Apply the effective per-turn model instead of retaining the model chosen when the session was created.
