# Changelog

## 0.2.0

- Live status UI: top pipeline stepper and per-stage worker panel, driven by on-disk status (persists across restarts).
- Worker viewer: read-only live view of a specialist's session (`alt+w`, `/relay-watch <name>`).
- Background workers: the orchestrator stays responsive while specialists run and gets completion notifications.
- `/relay-pause` and `/relay-resume`; crash-safe `--resume` (stale lock takeover, interrupted workers re-run, counters preserved).
- `/relay-init` (`--refresh`): repo scout agent drafts an evidence-backed AGENTS.md; optional Playwright verifier tooling in `.relay/tools`; `.gitignore`/`relay.config.json` setup; baseline checks.
- README: "Why Relay", "How Relay manages context", quickstart, init docs, verified-vs-unverified notes.

## 0.1.0

- Initial release.
