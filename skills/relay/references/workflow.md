# Workflow details

| Phase | Agent | Inputs | Outputs | Gate |
|-------|-------|--------|---------|------|
| baseline | (harness) | repo | state.checks | checks green or user OK |
| requirement | orchestrator | user text | requirement.md | - |
| research | relay-researcher | requirement.md, AGENTS.md, README.md | research.md | 3 citations spot-checked; user answers gaps |
| spec | relay-spec-writer | requirement.md, research.md, AGENTS.md | spec.md, features.json | schema valid |
| spec-approval | user | spec.md | approvals.spec | approved (cap 3 rounds) |
| design | relay-architect | spec.md, features.json, research.md, AGENTS.md, README.md | design.md, design.html, plan.json | schema + independence check |
| design-review | orchestrator + user | design.md vs spec.md | approvals.design | approved (cap 3 rounds) |
| implement | relay-implementor (one per slice) | plan.json, design.md, spec.md, features.json, AGENTS.md | code, tests, reports/impl-*.md | checks green per slice (cap 3) |
| verify | relay-verifier | spec.md, features.json, plan.json | evidence/, reports/verify-*.json, passes | all scenarios pass (cap 3) |
| review | relay-reviewer | diff, spec, design | reports/review.md | no blockers/majors (cap 2) |
| pr | orchestrator | everything | PR text with traceability table | secret scan clean |

Escalate to the user, with a short summary of what was tried, whenever a cap is exceeded, a worker reports a blocker, or a pinned contract must change.

Traceability table: `| spec item | scenario | evidence file | result |`, generated from features.json (passes + evidence).
