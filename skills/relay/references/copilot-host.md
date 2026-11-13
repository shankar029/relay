# Running Relay in GitHub Copilot

Read this when the host is GitHub Copilot (CLI or VS Code agent mode) instead of pi. The workflow in `workflow.md` is unchanged; only the mechanics differ.

## Substitutions

| pi mechanism | In Copilot |
|---|---|
| `relay_subagent` (separate process per worker) | Invoke the `relay-<role>` custom agent with the `agent`/`task` tool. Workers share the session process. For fan-out, issue all calls for a phase in the same turn so they run in parallel. |
| `harness_state` / `set_phase` | Edit `.ai/<slug>/state.json` by hand. Before each phase change run the gate yourself: confirm the required artefacts exist and validate against `schemas/`. |
| `relay_approval` | Ask the user in chat and wait. Record the decision in state.json. Never simulate it. |
| `relay_checks` | Run the repo's test/lint/SAST commands in the shell and save the output under `.ai/<slug>/reports/`. |
| `relay_secret_scan` | Run a secret scan (for example `gitleaks detect` or `git grep` for key patterns) before committing `.ai/<slug>/`. |
| Per-slice worktrees | Create them yourself: `git worktree add ../<repo>-<slug>-<slice> -b relay/<slug>/<slice>`; merge back in slice order. |

## What is NOT enforced here

Instruction-only (nothing stops a worker that ignores it): ownership of files per slice and the ownership revert, the test gate (changed behaviour without test changes), the budget cap and token counts, the review-round cap, the autonomy level, and separate processes per worker. After every worker returns, check `git diff --stat` yourself and revert out-of-ownership changes.

Enforced only if the optional `preToolUse` hook is installed: the holdout read block, per-role write permissions on `.ai/<slug>/`, `.git`, `node_modules`, `.env`, `AGENTS.md`, `README.md`; the bash write-confinement guard; `git push` block; commit only by `relay-implementor`. The hook identifies the role from the subagent's agent name, so it does not guard the root session unless `RELAY_ROLE=relay` is set, and it cannot see per-slice ownership globs.

## Models

`scripts/install-copilot.mjs` writes a `model:` into each agent from `relay.config.json`: `copilotOrchestrator` for the orchestrator, `copilotTiers[tier]` for workers (falling back to `tiers` with the provider prefix removed). Model names must match what your Copilot plan offers; edit the config if not.
