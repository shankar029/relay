# Init flow (`/relay-init`, `/skill:relay --init [--refresh]`)

Prepares a repo for feature runs. It starts no feature. Every write to user files and every install needs the user's explicit confirmation (`relay_init` asks via the UI itself, even at autonomy=autonomous; with no UI it declines). Never push. Never overwrite an existing AGENTS.md: `relay_init apply` shows a diff and only replaces the Relay-managed block (`<!-- relay:init:start/end -->`) or appends one.

## Steps
1. `relay_init action=preflight`. If it offers `bootstrap_git`, call `relay_init action=bootstrap_git` (it asks first). Warn about a dirty tree, detached HEAD, no remote (fine).
2. `relay_init action=detect` writes `.ai/repo-init/detection.json` (stacks, apps, candidate commands, ports, CI, runtime pins, docker compose, hooks, scanners, third-party SDKs).
3. `harness_state action=init slug=repo-init worktree=false`, then `relay_subagent` with agent `relay-repo-scout`, inputs `[".ai/repo-init/detection.json"]`. The harness gates its output: every `verified` command needs exit code 0 and a non-empty evidence log; `not-run` needs a reason. Failures are retried with the concrete problem.
4. `relay_init action=preview` and show the user the AGENTS.md diff/content and other planned changes. Then `relay_init action=apply` (items agents-md, gitignore, config; each is confirmed separately).
5. If detection says there is a browser UI, offer `relay_init action=install_verifier`. It installs Playwright + Chromium into `.relay/tools` (own package.json, project dependencies untouched), then runs a smoke screenshot. On success `relay.config.json` `verifier` is set, and verifier tasks get the absolute helper path. Run `apply` again afterwards so the config records it. API/CLI/library repos need nothing installed; mobile/desktop shells are noted as limits.
6. Optional: `relay_init action=baseline` runs the detected checks (skips destructive-looking commands) and stores logs under `.ai/repo-init/evidence/`.
7. `relay_init action=commit` (confirmed) commits only the files init wrote. `relay_init action=report` prints the summary and writes `.ai/repo-init/init-report.md`.

## Refresh
Re-run the same steps with `--refresh`: detection and the scout run again, `apply` only shows real diffs (idempotent), `install_verifier refresh=true` reinstalls.

## Not done automatically
Linux browser OS libraries (`npx playwright install-deps` needs sudo; reported as a note), installing gitleaks/semgrep (reported as missing; `relay_secret_scan` is the fallback), starting docker services, editing git hooks or CI.

## Workspace mode (non-git parent with child repos)

Run `/relay-init` in the parent folder; the same command initialises everything. `relay_init action=workspace_plan` lists each repo's init status (AGENTS.md block, verifier tools, prior init) and any child repos that are not in `relay.config.json` `workspace.repos` (those are never touched unless the user adds them). `bootstrap_git`, `.gitignore` writes and commits at the root are refused.

1. **Per repo** (sequentially; one orchestrator holds one active feature): `harness_state init worktree=false dir=<repo> slug=repo-init`, run `relay-repo-scout`, then `relay_init repo=<name>` for preview, apply, install_verifier (first repo with a browser UI is enough; tools live at the root `.relay/tools`), baseline, commit. With `--refresh`, repeat for every repo; unchanged files produce no prompt.
2. **At the root**, after the repos: `relay_init action=preview` then `apply items=[config, agents-md]`.
   - `relay.config.json`: adds only missing keys (`workspace.repos`, `workspace.exclude`, per-repo `checks`, `requiredChecks`, `autonomy`, `budget`); an existing key is never changed.
   - Workspace `AGENTS.md`: generated deterministically (`lib/wsinit.mjs`) from detection, not from an LLM: repo map with roles, declared and inferred inter-repo links with their evidence, per-repo commands (marked not executed at the root), suggested change order. Merged into a marked `relay:init` block; text outside it is kept; the user approves a diff first.
3. Finish with `report`. Per-repo reports live in each repo's `.ai/repo-init/`.

