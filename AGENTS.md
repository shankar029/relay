# AGENTS.md

Relay: orchestrator + specialist-agent harness (pi first, Copilot later). See README.md.

## Commands
- `npm install`
- `npm run check` = validate + test + typecheck. Run before committing.
- `node scripts/validate.mjs`: frontmatter lint (skills/agents) and schema validation of fixtures.
- `node --test test/`: unit tests for `lib/`.
- `npx tsc -p extensions/harness/tsconfig.json --noEmit`: typecheck the extension.

## Conventions
- `lib/*.mjs`: dependency-free ESM, shared by the extension and tests. Put logic here, keep `extensions/harness/index.ts` thin.
- Agents: `agents/<name>.md`, frontmatter `name` (= filename), `description`, `tools`, `tier`. Skills follow agentskills.io: `skills/<name>/SKILL.md`, name = dir, under 500 lines; detail goes in `references/`.
- No hardcoded model IDs: agents declare a `tier`, mapped in optional `relay.config.json`.
- pi APIs must come from the installed `@earendil-works/pi-coding-agent` types/docs; do not invent.
- Schemas in `schemas/` are the contract for `.ai/<feature>/` files; change them together with `lib/state.mjs`, fixtures, and tests.
