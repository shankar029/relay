# Brief template

Call `relay_subagent` with `mode` (`single` | `parallel` | `chain`) and `tasks[]`. Each task has `agent`, `brief`, and optional `step`, `slice`, `outputs`. A `brief` has `objective`, `outputFormat`, `guidance`, `boundaries`, `inputs` (array of full paths). The harness renders it, checks that every input exists, and appends the role's lessons.

Example (researcher):

```json
{
  "mode": "single",
  "tasks": [{
    "agent": "relay-researcher",
    "step": "research",
    "outputs": [".ai/<slug>/research.md"],
    "brief": {
      "objective": "Map the code relevant to the requirement.",
      "outputFormat": "Write .ai/<slug>/research.md with the sections defined in your agent file.",
      "guidance": "Start from AGENTS.md notes, then grep entry points.",
      "boundaries": "Read-only except research.md.",
      "inputs": [".ai/<slug>/requirement.md", "AGENTS.md", "README.md"]
    }
  }]
}
```

- `step`: write-ahead tracking in state.json (running before, done/failed after, `outputs` hashed).
- `parallel`: read-only agents, or implementors only when plan.json proves independence (same wave, `independence.parallelizable`, clean `checkPlan`). Max 4 at once.
- `chain`: sequential; `{previous}` in a later brief's text is replaced by the prior output.
- Implementor briefs should name the spec items to cover; the implementor must map each to a named test (integration/e2e for API, UI or cross-module slices) and report the mapping in `reports/impl-<slice>.md`. `plan.json` slices that list `features` must list `tests` (checked by `checkPlan`).
- Implementors need `slice: "<slice-id>"` so the harness sets file ownership from plan.json.
