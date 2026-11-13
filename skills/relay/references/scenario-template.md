# Scenario template (spec-writer)

Every scenario in features.json states: **given** (exact data/state), **action** (exact request or command), **expected** (exact status/body/exit code, with concrete values), and at least one **edge** (empty, duplicate, missing, already-in-state).
Avoid vague words (fast, appropriate, etc.); the lint rejects them.

## Lessons from past verifier failures
The harness records failing holdout `symptom`s in `.ai/spec-lessons.json` (committed with the feature). Spec-lint then warns on any scenario whose wording overlaps a past failure ("resembles a past verifier failure"). Resolve by stating the exact expected behaviour and the edge case that failed before. Typical recurring gaps: default-list filtering (archived/deleted items), validation error shape, idempotency of repeated calls, ordering and pagination defaults.