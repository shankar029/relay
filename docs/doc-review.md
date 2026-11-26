# Document review (spec and design)

Relay adds an EGM-style review loop between drafting and human approval. It is adapted from
Google's Elephant Goldfish Model (Apache-2.0, see `NOTICE`); Relay keeps the orchestrator, worker,
approval and evidence machinery it already had.

Flow (for `spec`, then again for `design`):

1. The spec-writer / architect drafts the document.
2. `harness_state docreview_lenses name=<doc>` lists lanes `<doc>-<lens>`. The orchestrator runs them in one
   parallel `relay_subagent` call of `relay-doc-reviewer` workers. Each is a fresh process that may read only
   the document, files it references and AGENTS.md (`lib/policy.mjs` blocks requirement, decisions, research,
   state, other reports and holdouts).
3. `docreview_consolidate` merges the lens reports deterministically (`lib/docreview.mjs`): de-duplicates, takes the
   highest severity, drops unscoped findings, flags findings that return after a fix as `reopened`, and fails if
   a lens report is missing or invalid (a missing review is never "clean"). It counts a round against the cap.
4. `docreview_resolve` classifies every finding: `fix`, `contest` (needs checkable evidence: an existing `path:line`
   or `section: <heading>`), `escalate`, or `decline` (minor only). Severity is never lowered; comprehension gaps are never contested.
5. Accepted fixes go back to the spec-writer/architect; repeat. One round with no unsettled blocker/major converges.
   Cap: `docReview.maxRounds` (default 3); then `docreview_close accept|skip` with a reason.
6. `set_phase` refuses `spec-approval` / `design-approval` until the review is converged, accepted or skipped.

Spec lenses: zoom-out, comprehension, critic, structural, style. Design lenses: zoom-out, comprehension, critic,
readiness, codebase, style. Config (`relay.config.json`): `docReview: { enabled, maxRounds, lenses: { spec: [...], design: [...] } }`.
State and reports: `.ai/<slug>/reports/docreview-<doc>-*.json|md`.

Taken from EGM: fresh-context lens reviewers, paraphrase test, settle/reopen, resolve rules, round caps, author-decides.
Skipped: bootstrap/lite/drift-report, the brainstorm swarm, branding/packaging, section-by-section interactive drafting,
two-clean-rounds (Relay uses one clean round, cap 3).
Relay already did better or differently: holdout scenarios + spec-lint, plan independence checks, and evidence-gated passes.