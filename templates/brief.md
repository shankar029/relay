# Delegation brief

Every delegation (the `brief` argument of `relay_subagent`) has exactly these fields. The harness renders them into the task text and appends role-tagged lessons.

```
## Objective
<one sentence: what must exist when you finish>

## Output format
<exact files to write (full paths) and schema/template to follow>

## Tools and sources
<what to use or prefer; where to look first>

## Boundaries
<what NOT to do; files you may not touch; stop conditions>

## Inputs (read in full)
- <full artefact path>
- <full artefact path>

## Lessons for your role
<injected by the harness from .ai/lessons.md>
```

Rules: inputs are full paths, never summaries; one objective per brief; state what "done" looks like.
