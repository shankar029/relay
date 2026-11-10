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
- Briefs never name output files or paths to write: the harness injects the authoritative "Required output files" per role. Name only inputs and intent.
- Unattended runs: never ask the user in chat to fix a tool/worker error. If a worker reports missing/invalid outputs or a tool call fails validation, correct the call and re-delegate (within counter caps). Ask the user only for real decisions (approvals, clarifications, stale-lock takeover).
- Implementors must add or update tests for every new behaviour in the same slice (tests live in the slice's owned globs; the architect must include a test path in every code slice). The harness fails and retries a code slice with no test changes, and `relay_checks` is not green without a test check.
- If a child's output is rejected (FAILED / MISSING REQUIRED OUTPUTS / plan errors), re-delegate that child with the harness's feedback quoted in the brief. Never write the child's files yourself; the guard will block it.
- Log each decision, with its reason, in `decisions.md`.
- Agents read AGENTS.md; researcher, architect, verifier, reviewer and implementors (only to write a slice-owned README) may read README.md; the spec-writer may not. If docs conflict with code, code wins and research flags it.
- Whole `.ai/<slug>/` is committed by the harness (`finalize`) after its secret scan. Only the allowed artefact layout is kept: spec/design/plan/features/research/decisions/pr files, `reports/impl-*.md`, `reports/verify-*.json`, `reports/review.md`, `evidence/**`, `verify-tools/verify-*`. Anything else is moved to `.ai/<slug>/_quarantine/` (not committed) and reported to you.
- The harness reverts out-of-ownership file changes an agent makes (even via bash) and tells you which.

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
7. **implement**: per slice in plan order, delegate `relay-implementor`. Parallel only for a wave plan.json proves independent (disjoint files, pinned contracts): put those slices in ONE `parallel` call; the harness gives each its own worktree (sub-branch `relay/<slug>--<slice>`), then merges them back in plan order and marks them `merged`. On a merge conflict that slice stays `failed` with its branch kept: re-delegate it sequentially (`single`). Sequential slices are marked `merged` automatically when they pass. After each slice run `relay_checks`; failure: re-delegate with the output (counter `impl-<slice>`, cap 3). After merging slices run an integration `relay_checks` (slice worktrees have no node_modules; install in the feature worktree).
8. **verify**: delegate `relay-verifier` (spec scenarios). Failures go back to implementors with the evidence; re-verify only the failed items (counter `verify-rounds`, cap 3). Finish with one full verification pass. `set_phase review` is refused unless every scenario passes with non-empty evidence under `evidence/`.
9. **review**: after green checks delegate `relay-reviewer`; send blockers/majors to implementors, then re-run checks (counter `review-rounds`, cap 2).
10. **pr**: `harness_state pr_draft` (`text` = summary, `name` = title, `symptom` = caveats one per line) writes `pr.md` deterministically (traceability, checks, verification, review, `gh pr create` command shown not run). Then `harness_state finalize`: it runs the secret scan, commits `.ai/<slug>/` on the feature branch and sets state done. `set_phase done` is refused. Never push or open the PR.

Lessons: when the same failure occurs twice, add one `harness_state lesson_add` (role-tagged, symptom => rule). The harness injects only that role's lessons into briefs.

## References
- `references/brief-template.md`: delegation brief fields.
- `references/resume.md`: resume protocol and state semantics.
- `references/workflow.md`: per-phase inputs, outputs and gates.
