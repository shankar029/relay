# Digital twins and mocks for third-party APIs

Never verify against live third-party services (cost, flakiness, side effects, secrets).
- Put a "Third-party APIs" section in design.md. For each external service name: the twin (local fake server or in-process fake implementing the same contract), how it is started in tests, and which failure modes it simulates (timeout, 4xx/5xx, rate limit, malformed body).
- Prefer, in order: a vendor-provided sandbox/emulator; a local twin behind the same interface (inject the base URL via config); recorded fixtures for read-only calls.
- Implementors build against the twin; the verifier runs holdout scenarios against the twin too. Real credentials never enter the repo or briefs.
- The design gate (`lib/twins.mjs`) rejects a design when the spec mentions an external service but the section or a twin/mock/fake/fixture is missing.