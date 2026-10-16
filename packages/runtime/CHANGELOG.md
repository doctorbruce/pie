# Changelog

## [Unreleased]

### Added

- Added an advisory reminder after three consecutive calls to the same tool with identical JSON arguments, without blocking execution or imposing a step limit.
- Added optional `sessionRetention: "release-after-turn"` to release idle Agents and working history after durable settlement and reload them through the injected store, while keeping local in-memory reuse by default.
