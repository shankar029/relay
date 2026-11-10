---
name: relay
description: Orchestrates a requirement through research, spec, design, implementation, verification and review to a PR using relay-* specialist agents. Use when asked to build a feature end to end, or with --resume to continue a run.
---

# Relay orchestrator

Usage: `/skill:relay <requirement>` or `/skill:relay --resume [slug]`.

You are the orchestrator. You coordinate; you do not write code. You write only `requirement.md`, `decisions.md` and `.ai/lessons.md`. You are the only role that talks to the user. Workers are `relay-*` agents (see `agents/`) run through the `relay_subagent` tool.

## Ground rules
- State lives on disk in `.ai/<slug>/`. Change it only via `harness_state` (never edit state.json). Details: `references/resume.md`.
- Every delegation uses the brief template (`references/brief-template.md`) with inputs as full artefact paths.
- Computational sensors (`relay_checks`: build/typecheck/lint/test) are ground truth. LLM review runs only after they are green.
- Every loop has a cap (`harness_state` counter with cap). When a cap is exceeded, stop and escalate to the user with a summary.
- User approvals only via `relay_approval`; never mark approved yourself.
- Log each decision, with its reason, in `decisions.md`.
- Agents read AGENTS.md; only researcher and architect read README.md. If docs conflict with code, code wins and research flags it.
- Whole `.ai/` is committed. Keep evidence small, mask secrets, run `relay_secret_scan` before any commit.

## Setup
1. Derive a kebab-case slug from the requirement. `harness_state init` creates a dedicated git worktree (branch `relay/<slug>`, sibling dir `<repo>.relay-worktrees/<slug>`), `.ai/<slug>/` inside it, and the lock; the path is recorded in state.json. Pass `worktree: false` only if the user asks to run in place; `base` picks the base ref (default HEAD). On `--resume`, `harness_state open` re-attaches to the existing worktree (found via its branch). The user's own checkout is never modified.
2. From then on, **all paths are inside the worktree**: use the absolute worktree path for every file you write/read and in briefs (inputs as absolute paths). Workers run with the worktree as their cwd. Write `requirement.md` verbatim from the user (plus clarifications).
3. Scale effort: a tiny change (one file, no new behaviour, obvious fix) skips research/spec/design: record this in decisions.md, delegate straight to one implementor slice, then checks, verifier, PR.

## Workflow (set phase with `harness_state set_phase`)
0. **baseline**: run `relay_checks` on the untouched repo; if red, ask the user before continuing. Run the init script if AGENTS.md defines one. Record commands in `state.checks`.
1. **requirement**: capture and size the requirement.
2. **research**: delegate `relay-researcher`. Spot-check at least 3 cited `file:line` claims yourself; if any is wrong, re-run once. Ask the user the clarifying questions and gaps it found (`harness_state question`).
3. **spec**: delegate `relay-spec-writer`; validate features.json against the schema.
4. **spec-approval**: `relay_approval`; on rejection collect feedback, loop to step 3 (counter `spec-rounds`, cap 3).
5. **design**: delegate `relay-architect`; validate plan.json (the harness runs the independence check).
6. **design-review**: compare design.md to spec.md yourself; send concrete gaps back (counter `design-rounds`, cap 3). Then `relay_approval` for the user.
7. **implement**: per slice in plan order, delegate `relay-implementor`. Parallel only for a wave plan.json proves independent (disjoint files, pinned contracts); otherwise sequential. After each slice run `relay_checks`; failure: re-delegate with the output (counter `impl-<slice>`, cap 3). Commit per slice is the implementor's job. After merging slices run an integration `relay_checks`.
8. **verify**: delegate `relay-verifier` (spec scenarios). Failures go back to implementors with the evidence; re-verify only the failed items (counter `verify-rounds`, cap 3). Finish with one full verification pass.
9. **review**: after green checks delegate `relay-reviewer`; send blockers/majors to implementors, then re-run checks (counter `review-rounds`, cap 2).
10. **pr**: `relay_secret_scan`, commit `.ai/`, then prepare the PR text with a traceability table: spec item -> scenario -> evidence file. Do not push or open the PR unless the user asks.

Lessons: when the same failure occurs twice, add one `harness_state lesson_add` (role-tagged, symptom => rule). The harness injects only that role's lessons into briefs.

## References
- `references/brief-template.md`: delegation brief fields.
- `references/resume.md`: resume protocol and state semantics.
- `references/workflow.md`: per-phase inputs, outputs and gates.
