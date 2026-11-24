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

- `relay_init action=preflight` reports `mode: workspace` and the repo map. `bootstrap_git`, `.gitignore` writes and commits at the workspace root are refused.
- For each repo run the normal flow with `repo=<name>` (scout feature: `harness_state init worktree=false dir=<repo> slug=repo-init`, then `relay_init repo=<name>` for preview/apply/baseline/commit). Scouts run sequentially: one orchestrator holds one active feature.
- At the root: a short workspace `AGENTS.md` (repo map, inter-repo dependencies, cross-repo conventions; draft at `.ai/repo-init/agents-draft.md`, then `relay_init action=apply items=[agents-md]`), a `relay.config.json` (per-repo checks as `checks: {"<repo>": {build, test}}`, optional `workspace: {repos, exclude}`), and verifier tooling installed once (`install_verifier`, at `<root>/.relay/tools`).