# Resume protocol

Disk is the source of truth. `/skill:relay --resume [slug]` (no slug: pick from `.ai/*/state.json`, ask if several).

## state.json
phase; steps (pending/running/done/failed with inputs, outputs + sha256); counters {count, cap}; approvals; artifacts {path, sha256}; checks; slices (pending/running/merged/failed + commit); pendingQuestions. Written atomically (temp + rename) and schema-validated on every write. Write-ahead: pass `step` to `relay_subagent` so it is marked `running` (with inputs) before the agent starts and `done` (with outputs) after.

## Steps on resume (`harness_state open`)
1. Take the lock (`.ai/<slug>/.lock`, PID + timestamp). Held by a live PID: refuse. Stale (dead PID or >6h): ask the user, then `open` with `takeover: true`.
2. Load and schema-validate state.json. Corrupt: tell the user; re-run the step that produced it from decisions.md and artefacts.
3. Read decisions.md. Verify artefact hashes; a changed or missing artefact means its step and all later dependent steps are re-run (ask the user if the change looks intentional).
4. Compare git: every slice marked `merged` must have its commit reachable (`git merge-base --is-ancestor`); report dirty worktrees.
5. Steps still `running`: read-only steps (research, spec, design, verify, review) are simply re-run. Implementor steps: if the worktree is clean and `relay_checks` pass, mark done; otherwise `git reset --hard` to the last slice commit (confirm with the user) and re-run.
6. Re-ask every entry in `pendingQuestions` and any `pending` approval.
7. Continue at `phase`.

## Fresh context
At phase boundaries the orchestrator may end its session and be restarted with `/skill:relay --resume <slug>`; nothing needed lives only in the conversation.
