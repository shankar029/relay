# Worked example


Run 14 used this requirement on a small Node/Express-style todo API (`sample-api`, outside this repo): *"Add an audit trail and outbound webhooks to the sample API. (1) Audit log ... exposed via GET /todos/:id/history (404 unknown id). (2) Webhooks: POST /webhooks ... (3) GET /stats/activity ..."*. Approvals in this run were **simulated** with `--simulate-approvals`. Excerpts are trimmed.

**1. Approval prompt** (what a human sees in the driver or in pi, title `Approve spec?` or `Approve design?`):

```
[APPROVAL REQUIRED] Approve spec?
<short message from the orchestrator pointing at .ai/<slug>/spec.md and features.json>
Approve? [y/N]
```

(In pi, the same title appears as a confirm dialog. In run 14 the driver logged `[SIMULATED APPROVAL]` for both.)

**2. `spec.md`** (excerpt). Note the honest "unresolved" markers:

```markdown
# Spec: Task item audit trail and outbound webhooks
## Scope
- Store-recorded audit events for successful task item creation, updates, deletion, and archive-like changes.
- `GET /todos/:id/history`, with 404 for a never-known item ID.
...
## Non-goals
- No new archive endpoint or archive field is invented by this specification; the required archive-like operation needs clarification.
```

**3. `features.json`** (excerpt). Each scenario has steps and a `passes` flag that only the verifier may set, with evidence files:

```json
{ "name": "preserve-todo-api",
  "scenarios": [ { "name": "todo-crud-remains-compatible",
    "steps": ["Start a fresh application using the existing createApp() call ...",
              "POST /todos with JSON {\"title\":\"write release notes\"}; expect 201 ...", "..."],
    "passes": true } ] }
```

**4. `plan.json`** (excerpt). Pinned contracts that slices must honour:

```json
{ "contracts": [ { "name": "audit-event", "pinned": true,
    "location": ".ai/todo-audit-webhooks/design.md#audit-event",
    "description": "src/audit.js exports AUDIT_ACTIONS and EVENT_BY_ACTION. AuditEvent has exactly todoId, ISO UTC timestamp, create/update/delete action, and detached before/after snapshots ..." } ],
  "slices": [ "audit-history-activity", "webhook-lifecycle-delivery" ] }
```

The two slices in this run had a dependency between them, so they ran one after the other, not in parallel.

**5. `pr.md`** (excerpt):

```markdown
# Add todo audit trail, webhooks and activity stats
## Traceability (spec item -> scenario -> evidence)
| Spec item | Scenario | Result | Evidence |
| Preserve existing task item HTTP behaviour | todo-crud-remains-compatible | pass | `.ai/todo-audit-webhooks/evidence/todo-crud-remains-compatible.json` |
...
## Verification
- holdout satisfaction: 4/4 (100%; hidden scenarios, not committed; the per-scenario `passes` gate above stays authoritative)
## Review
# Review (consolidated from 4 lenses: correctness, performance, security, tests)
- **minor** `src/webhooks.js:27` [security] Default webhook delivery permits requests to internal destinations
## Caveats
- Archive-like changes are audited as ordinary 'update' (no archive trigger exists in the API).
- Webhook destinations are not restricted (SSRF) — demo only; restrict before exposing to untrusted callers.
```

Run 14 outcome (from its `state.json`): phase `done`, 14 delegated calls, review rounds used 2 of 2, both slices `merged`. It used one researcher.

