# Changelog

## 0.3.2

- `relay_pr`: after finalize and your confirmation, pushes only `relay/<slug>` (never force) and opens one PR per affected repo via `gh`, cross-linked, URLs recorded in `state.prs`, idempotent on resume; `pr.auto=false` or missing gh/remote leaves `pr.md`. Verified live on throwaway GitHub repos (not through the full TUI confirm).
- Cross-repo verification: verifier brief requires producer-then-consumer real-HTTP runs with `evidence/xrepo-*`; `relay_subagent` flags missing cross-repo evidence.
- Workspace init: infers service/client roles and `client -> server` links from source; tier lookup falls through a per-repo config without tiers to the workspace config (fixed `model_not_available` on `--refresh`).
## 0.3.1

- Workspace-aware `/relay-init`: run at the parent folder to list repo init status (`workspace_plan`), init each repo, then write root `relay.config.json` (missing keys only: `workspace`, per-repo `checks`, ...) and a workspace `AGENTS.md` (repo map, roles, inter-repo links with evidence, commands, change order). Never overwrites user config; unlisted repos untouched.

## 0.3.0

- Multi-repo workspace mode: run from a non-git parent folder with child repos. Per-feature container (`.relay-features/<slug>/`) holds `.ai/<slug>/`; lazy per-repo worktrees on `relay/<slug>`; slices carry a `repo`; per-repo ownership, test gate, checks (`<repo>:test`), merges; one `pr-<repo>.md` per repo plus a feature `pr.md`; `[repo]` tags in the status UI. See docs/multi-repo.md.
- Fix: repo-qualified check keys are now accepted by the state schema and recorded by `relay_checks`, so the review gate can pass in workspaces.
- Not yet verified: workspace-level `/relay-init`, parallel cross-repo slices live, Copilot guard in containers (see README).
## 0.2.0

- Live status UI: top pipeline stepper and per-stage worker panel, driven by on-disk status (persists across restarts).
- Worker viewer: read-only live view of a specialist's session (`alt+w`, `/relay-watch <name>`).
- Background workers: the orchestrator stays responsive while specialists run and gets completion notifications.
- `/relay-pause` and `/relay-resume`; crash-safe `--resume` (stale lock takeover, interrupted workers re-run, counters preserved).
- `/relay-init` (`--refresh`): repo scout agent drafts an evidence-backed AGENTS.md; optional Playwright verifier tooling in `.relay/tools`; `.gitignore`/`relay.config.json` setup; baseline checks.
- README: "Why Relay", "How Relay manages context", quickstart, init docs, verified-vs-unverified notes.

## 0.1.0

- Initial release.
