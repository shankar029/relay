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
Every feature runs in its own git worktree by default (branch `relay/<slug>`, dir `<repo>.relay-worktrees/<slug>`), with `.ai/<slug>/` inside it so artefacts are committed with the feature; `harness_state init worktree=false` runs in place, and `open` re-attaches on resume. Workers run as separate pi processes with only their tools; they get no orchestration tools, so they cannot spawn sub-agents. A `tool_call` guard blocks writes outside a role's allowed files (implementors: slice-owned globs), `state.json`, `AGENTS.md`/`README.md`, `.env`, `.git`; blocks `git push`; and limits `git commit` to implementors. Only `relay_approval` (user UI) can approve a gate; only the verifier's `relay_set_passes` can set `passes`, and only with existing evidence files.

## Copilot
`node scripts/gen-copilot-agents.mjs` writes `.github/agents/*.agent.md`. The file format was checked against GitHub's custom-agent docs, but relay-specific tools have no Copilot equivalent yet, so the harness/orchestrator do not run there. Partial and untested.

## Checks
`npm run check`

## Known limitations
- Verified: schemas, lib logic, frontmatter lint, extension typechecks against pi 1.5.0 types. Not verified: a live end-to-end pi run (extension loading, real child agents).
- The `bash` tool can still write anywhere while an agent runs; after every agent run the harness diffs against the pre-run HEAD and reverts (and reports) out-of-ownership changes, including committed ones. Reads of ignored/untracked paths are not policed.
- Parallel implementors each get their own worktree (`<slug>--<slice>`, branch `relay/<slug>--<slice>`), merged back `--no-ff` in plan order after the batch; conflicts abort that merge, mark the slice `failed` and keep its branch/worktree for sequential re-delegation. Slice worktrees have no `node_modules`.
- Files in `.ai/<slug>/` outside the allowed layout (see `lib/policy.mjs` `isLayoutFile`) are moved to `.ai/<slug>/_quarantine/` after each delegation. The PR phase is `pr_draft` (writes `pr.md`) then `finalize` (secret scan, commit `.ai/<slug>/`, state done); no push, no PR.
- Holdout scenarios (StrongDM-style hidden e2e tests): the spec-writer writes `.ai/<slug>/holdout/scenarios.json`; only the verifier reads it and writes `holdout/results.json` + `holdout/evidence/**`. Read guards block every other role (including bash/grep/find/ls commands mentioning `holdout`), the dir is git-excluded and never committed, and slice worktrees branch from committed state. The harness computes the satisfaction score (credible passes / total); `satisfactionThreshold` in `relay.config.json` (default 1) is the minimum to enter review; the score appears in `pr.md`. Visible `passes` stays the authoritative gate. `lib/speclint.mjs` warns about vague or unobservable features.json scenarios at spec-approval. Limits: the bash guard is text-based and can be obfuscated around; holdouts are not live-tested in pi yet.
- `set_phase` also validates content (schemas, approvals recorded, slices merged, verifier evidence for every passing scenario, review report) via `lib/gates.mjs`.
