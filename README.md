# Relay

Minimalist harness that takes a requirement to a PR using an orchestrator skill plus specialist agents. Targets the [pi coding agent](https://github.com/earendil-works/pi) first; GitHub Copilot support is partial (see below).

## Layout
| Path | Purpose |
|---|---|
| `skills/relay/` | Orchestrator skill (`/skill:relay <requirement>`), with `references/` for brief template, resume, workflow |
| `agents/` | `relay-researcher`, `-spec-writer`, `-architect`, `-implementor`, `-verifier`, `-reviewer`, plus `relay.md` (orchestrator role) |
| `extensions/harness/` | pi extension: `relay_subagent` (isolated pi processes; single/parallel/chain, forked from pi's subagent example), `harness_state`, `relay_approval`, `relay_checks`, `relay_secret_scan`, write/commit guards |
| `schemas/` | JSON Schemas: state, features, plan, verifier report |
| `templates/` | brief, spec, design, lessons |
| `lib/` | shared logic (state, locks, plan checks, policy, lessons, secrets) |
| `scripts/` | `validate.mjs`, `gen-copilot-agents.mjs` |

## Workflow
baseline checks -> requirement -> research -> spec -> user approves -> design (architect) -> orchestrator review + user approves -> implement slices -> verify (QA-style, evidence) -> review -> PR with traceability table. Loops are capped and escalate to the user. Artefacts live in `.ai/<feature-slug>/` in the target repo and are committed so runs resume anywhere. Details: `skills/relay/references/workflow.md`.

## Use with pi
```
npm install
pi -e ./extensions/harness/index.ts --skill ./skills/relay
/skill:relay <requirement>
/skill:relay --resume [slug]
```
Agents are read from `agents/`. Optional `relay.config.json` maps tiers to models: `{"tiers":{"strong":"<model>","mid":"<model>","cheap":"<model>"}}` (looked up in the cwd, then the Relay repo).

## Enforcement
Workers run as separate pi processes with only their tools; they get no orchestration tools, so they cannot spawn sub-agents. A `tool_call` guard blocks writes outside a role's allowed files (implementors: slice-owned globs), `state.json`, `AGENTS.md`/`README.md`, `.env`, `.git`; blocks `git push`; and limits `git commit` to implementors. Only `relay_approval` (user UI) can approve a gate; only the verifier's `relay_set_passes` can set `passes`, and only with existing evidence files.

## Copilot
`node scripts/gen-copilot-agents.mjs` writes `.github/agents/*.agent.md`. The file format was checked against GitHub's custom-agent docs, but relay-specific tools have no Copilot equivalent yet, so the harness/orchestrator do not run there. Partial and untested.

## Checks
`npm run check`

## Known limitations
- Verified: schemas, lib logic, frontmatter lint, extension typechecks against pi 1.5.0 types. Not verified: a live end-to-end pi run (extension loading, real child agents).
- The `bash` tool can bypass write guards; mitigated by a post-run git ownership check on implementors, which reports violations.
- Parallel implementors share one working tree (disjoint owned files, each commits only its own).
