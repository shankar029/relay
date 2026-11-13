# Copilot port: plan and mapping

Status: a first install path exists (`npm run install:copilot`, see the README "Copilot port" section). Agents, skill and a `preToolUse` guard hook are generated; the harness tools (`relay_*`) are NOT ported, so state, gates, test gate, budget and ownership revert are instruction-only on Copilot. The MCP-server option in the table below remains the route to full parity and is not built. Original plan follows.


Goal: run Relay under GitHub Copilot (CLI / app) in addition to pi, keeping `lib/*.mjs`, `schemas/`, `agents/*.md`, `skills/relay/` as the single source of truth. Only the thin host adapter (`extensions/harness/`) is pi-specific.

## Concept mapping

| Relay concept | pi (today) | Copilot (target) |
|---|---|---|
| Orchestrator skill | `skills/relay/SKILL.md` (agentskills.io) | Same SKILL.md as a Copilot skill; Copilot agent skills follow the same format |
| Specialist agents | `agents/relay-*.md`, run as child pi processes via `relay_subagent` (`run.ts`) | Custom agents (`.github/agents/*.agent.md` / plugin agents) or the `task` sub-agent tool; frontmatter `tools`/`tier` map to Copilot tool allow-lists and a model |
| Tier -> model | `relay.config.json` `tiers` to `provider/model` | Same tiers; Copilot model IDs (e.g. `claude-sonnet-5.5`, `gpt-6.1-sol`) in config; per-agent `model` where the host supports it |
| Custom tools (`harness_state`, `relay_checks`, `relay_approval`, `relay_secret_scan`, `relay_set_passes`, `relay_subagent`) | `pi.registerTool` | An MCP server (stdio) exposing the same tools; handlers call `lib/*.mjs` unchanged |
| Write/read guards (ownership, holdout, README) | `pi.on("tool_call")` blocking hook | Copilot `preToolUse` hooks (hooks config) calling a `lib/policy.mjs` CLI wrapper that exits non-zero to deny; plus git-diff ownership revert (already host-neutral) |
| Parallel fan-out | `relay_subagent` parallel mode, one process per task | Parallel `task` sub-agents, or the MCP tool spawning `copilot -p` children with the same env contract (`RELAY_CHILD`, `RELAY_ROLE`, `RELAY_OWNED`) |
| Approvals | `ctx.ui.confirm` / driver stdin | `ask_user` / MCP elicitation; `autonomy` config unchanged |
| Usage/budget | `message_end` usage in `run.ts` | Copilot session usage events or child process JSON output; same `lib/budget.mjs` |
| Status command | `pi.registerCommand("relay-status")` | Slash command / skill prompt reading `harness_state get` |

## Plan

1. **Extract host-neutral core**: move tool handler bodies out of `index.ts` into `lib/handlers.mjs` (pure functions taking `{cwd, params}`); `index.ts` becomes registration only. Existing tests keep passing.
2. **MCP server** (`mcp/server.mjs`, stdio) registering the same tools over `lib/handlers.mjs`. Verify with an MCP client test.
3. **Hooks**: `hooks/relay-guard.mjs` reading the Copilot hook payload (tool name, args), reusing `checkWrite`/holdout read guards; deny by exit code. Verify with hostile probes as in P1.3.
4. **Child runner**: `lib/runner-copilot.mjs` implementing the same `runAgent` contract (task, role, owned paths, tokens/turns) via `copilot -p` or the task tool; select by `relay.config.json` `host`.
5. **Packaging**: Copilot plugin manifest bundling skills, agents, MCP server and hooks; README install steps.
6. **Live validation**: repeat the sample-repo medium-feature run with Sonnet orchestrator and Sol specialists under Copilot.

## Risks / unknowns

- Hook payload and deny semantics must be confirmed against current Copilot docs before step 3; bash write guard parity relies on the git-diff revert.
- Child-process model selection and token reporting may differ; budget counts could be approximate.
- Parallel sub-agent isolation (own worktrees) must be created by the MCP tool, not the host.
- Tool names may need a prefix (`relay_`) to avoid collisions with host tools.