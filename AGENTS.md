# Development Rules

## Repository Scope

- 本仓库是独立 Pie Core 与本地 HTTP/SSE 宿主，不附带 Web UI，也不是上游 Pi CLI monorepo；工作区与可用命令以根 `package.json` 的 `workspaces` 和 `scripts` 为准。
- 共享会话与执行语义放在 `packages/runtime`，本机存储和能力适配放在 `packages/local`，`packages/server` 只负责本地宿主装配和 HTTP/SSE。修改分层或嵌入接口前先读 `docs/agent-development.md` 和 `docs/runtime-embedding.md`。

## MCP Integration

修改 MCP 配置、工具或生命周期时先读 `docs/mcp-integration.md`。协议源位于 `packages/mcp`；共享契约位于 `packages/runtime/src/mcp.ts`；本地连接、权限和工具适配位于 `packages/local/src/mcp.ts`。同步上游时保留原测试和适用许可，Sidecar 发行须携带对应 `.LICENSES.txt`。

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Feature Specs

- 新功能实现前，在 `docs/specs/<feature>.md` 创建或更新一份简短 SPEC，写清问题与目标、本次范围与不做的事、实现思路、验收方式。已有对应 SPEC 时直接维护同一份。
- 开始实现时将状态改为“进行中”；实现思路或范围改变时，同步更新 SPEC，保持它与实际工作一致。
- 每个阶段完成后，在同一份 SPEC 回填实际改动及关键文件、验证命令与结果、未完成项和相对原方案的偏差。待办或未验证内容应明确标注，验收完成后再将状态改为“已完成”。
- SPEC 保持简短，不要求大型模板或逐行开发流水账。

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- Sidecar 打包默认使用 Bun（`npm run build:sidecar:bun`）；仅在环境中找不到 `bun` 可执行文件时，回退 Node SEA（`npm run build:sidecar`）。
- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` unless requested by the user.
- Run the smallest relevant test set. Current root scripts are `npm run test:runtime`, `npm run test:server`, `npm run test:core`, and `npm run test:mcp`.
- For a specific test (`<test-file>` is the path to an existing test):
  - Runtime/server (`node:test`), from the repo root: `node --conditions=source --test <test-file>`.
  - Agent/AI/MCP (Vitest), from the package root: `node ../../node_modules/vitest/dist/cli.js --run <test-file>`.
- Do not run repository-wide Vitest discovery. `packages/ai/test` contains tests that read credentials and call real providers; select specific files. Agent/runtime/server regression tests use faux providers or local fixtures; do not use real provider APIs, keys, or paid tokens without an explicit user request.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, write them to a file in the system temp directory (`$env:TEMP` in PowerShell), run, edit if needed, and remove when done. Don't embed multi-line scripts in shell commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(scope)]: <commit message> (optionally multiple lines)`. Use the affected package or app as the optional scope. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Inspect the target repository's labels and apply relevant existing labels.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- If the originating prompt specifies an AI-generated disclaimer, append that exact line.

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Changelog

Update an affected package's existing `CHANGELOG.md` when needed; not every package has one.

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when working on a branch other than `main` or pull request

Attribution:

- Link issues and PRs to the repository they actually belong to; retain upstream attribution for upstream changes.

## Sidecar Delivery

- 根包为 private，当前没有 npm release 脚本或 CI 发布工作流；不沿用上游的统一版本、标签和 npm 发布步骤。
- Sidecar 打包遵循 Commands 中的 Bun 优先规则；产物路径与宿主接入方式见 `README.md` 的“本地运行”部分。未执行的构建、部署或运行验证应明确说明。

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
