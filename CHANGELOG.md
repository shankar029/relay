# Changelog

## 0.4.1

- **Doc-review noise reduction.** Root cause of one junk finding: the zoom-out checklist told reviewers to report "No false compromise detected" when they found nothing; it now says to report nothing. The consolidator also drops "no problem" titles, clamps style-lens findings to minor, and merges cross-lens duplicates (title-token overlap and overlap-coefficient rules). The reviewer prompt has a stricter severity rubric (major only if an implementer/tester would build or check the wrong thing, or two parts contradict).
- **Packaging fix:** `NOTICE` (Apache-2.0 attribution for the adapted EGM material) and `CHANGELOG.md` are now in the npm package `files`; 0.4.0 shipped the adapted files without NOTICE.
- **Benchmark (manual/regex-graded, small, single model gpt-6.1-sol, 3 replicates).** 5 seeded docs per kind of doc (due/tags/page features, spec+design = 25 seeded flaws) plus 2 "clean" features, each with a real `requirement.md`. Arms: a simulated v0.3.2 single-pass review (one unguarded agent; real v0.3.2 had no spec review), v0.4.0 lanes with the old prompt, v0.4.0 lanes after this release. Seeded flaws detected: single pass 70/75 (93%), old lanes 67/67 of completed runs (100%), new lanes 73/75 (97%). Raw findings per seeded doc: 8.1 / 19.8 / 14.5; blocking findings per seeded doc after consolidation: 5.8 / 13.9 / 8.7. Tokens per doc (cache reads included): ~55k / ~122k / ~110k. Differences in detection are within noise at this sample size; the new lanes cost roughly 2x the single pass in tokens and still report more blocking findings than it. We do not claim better detection.
- **Limits:** the "clean" docs were not actually clean (reviewers in both arms repeatedly found the same real issues, e.g. HEAD cannot return a JSON body, invalid date on an unknown id), so the false-positive rate is not measured; findings were matched to seeded flaws by regex rubric with a manual spot-check; one old-prompt lane hung for a long time (2 runs missing). Leak audit of 330 lane transcripts: no canary strings from requirement/concepts/decisions/holdout/state files, no tool call naming those files; reviewers made no bash/edit/subagent calls (bait was never attempted, so the read guard itself was not exercised live; it is unit-tested).
- Verified live in pi (orchestrator claude-sonnet-5.5 calling `harness_state`; approvals simulated): `set_phase` refuses spec-approval/design-approval while the doc review is unconverged, accepting the review clears that specific refusal, the 4th `docreview_consolidate` is refused at the round cap (3/3), and round counters persist across separate pi processes. Not verified live: design-approval passing end to end, multi-repo doc review, a kill mid-lane (only between rounds).
## 0.4.0

- **Document review (adapted from Google's Elephant Goldfish Model, Apache-2.0; see NOTICE, docs/doc-review.md).** After the spec and after the design, fresh-context `relay-doc-reviewer` workers (one lens each, run in parallel; they may read only the document and what it references) report findings; the harness consolidates them deterministically, you classify each finding (fix / contest with checkable evidence / escalate / decline minor), accepted fixes go back to the spec-writer or architect, and a clean round converges (cap 3, configurable via `docReview`). `set_phase` blocks spec-approval/design-approval until the review is converged, accepted or skipped with a reason. A missing or invalid lens report is an error, never a clean review.
- Optional `concepts.md` concept brief with the author-decides rule; plain-English rules for spec-writer and architect.
- **Taken from EGM:** lens reviewers, comprehension paraphrase test, settle/reopen, resolve rules, round caps. **Skipped:** bootstrap/lite/drift-report, brainstorm swarm, branding and packaging, interactive section-by-section drafting, two-clean-rounds. **Relay already did better/differently:** holdout scenarios with spec-lint, plan independence checks, evidence-gated passes, so those were kept as they were.
- Positioning: Relay is the execution layer (parallel implementors, evidence-gated verifier, code review, multi-repo, resumable state, per-repo PRs) behind EGM-style spec/design review. No comparative performance claims.
- Verified live (pi, gpt-6.1-sol, simulated approvals) on a sample API: spec review ran 5 parallel real reviewers, found real issues (e.g. multiline query vs input type=search), fixes were applied, converged in round 2; design review ran 6 lenses, converged in round 2. Not verified live: the Copilot port of the new agent (generated, guard is instruction-only), contest/escalate paths with real reviewers (unit-tested only), multi-repo doc review, implementation after reviewed docs. Evidence is kept outside the repo.

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
