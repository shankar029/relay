# Multi-repo (workspace) mode

Typical layout: agents run in a parent folder that holds several clones. The parent is local-only and **not** a git repo.

```
workspace/            (not a git repo)
  api/  .git          main checkouts, never modified by Relay
  web/  .git
  .relay-features/
    add-widget/       feature container: tiny local git repo holding .ai/add-widget/
      .ai/add-widget/ state, spec, design, plan, evidence, holdout, reports, pr*.md
      api/            git worktree of ../api on branch relay/add-widget  (created lazily)
      web/            git worktree of ../web on branch relay/add-widget  (created lazily)
```

## What assumed one repo (before)

| Area | Assumption | File |
|---|---|---|
| Worktree | `ensureWorktree` needs `git rev-parse --show-toplevel`; places the worktree at `<repo>.relay-worktrees/<slug>` | `lib/worktree.mjs` |
| State / `.ai` | `.ai/<slug>/` lives in the one feature worktree; `state.worktree` is a single path/branch | `extensions/harness/index.ts`, `schemas/state.schema.json` |
| Guards / ownership | globs relative to one cwd; `enforceOwnership`, `changedSince`, slice worktrees and merges are one-repo git operations | `lib/gitflow.mjs`, `lib/policy.mjs` |
| Checks | `relay_checks` runs one command set in one cwd; results gated against one HEAD | `lib/gates.mjs` |
| Finish | one `base..HEAD`, one `pr.md` | `renderPr` |
| Init | repo = cwd; `bootstrap_git` would `git init` the parent | `relay_init` |
| Status / resume | worktree discovery via `git worktree list`; stash/dirty/missing-commit checks on one repo | `lib/status.mjs`, `harness_state open` |
| Copilot guard | cwd-based | `lib/copilot.mjs` |

## Design: one container per feature

The suggested "artefacts at the workspace root" was refined into a **per-feature container directory** that is itself a small git repo, with each touched repo's worktree nested inside. Reasons:

- Every path the agents see is naturally repo-qualified (`api/src/x.js`). The existing guards, ownership globs, holdout hiding, artefact allow-list, quarantine and cwd-confinement therefore work unchanged on container-relative paths.
- Artefacts get git history (the local-only safety net) without touching the non-git parent or the user's repos. `finalize` commits them in the container; nothing is pushed.
- Slice worktrees and merges reuse the single-repo code: a slice gets a container slice-worktree plus a nested worktree of its one repo.
- Single-repo mode is untouched: the workspace path only activates when cwd is *not* a git repo and has child git repos (`relay.config.json` `workspace.repos` / `workspace.exclude` override discovery).

Behaviour:

- **Plan**: `plan.repos`, `slice.repo`; all globs repo-qualified; `checkWorkspacePlan` rejects unqualified or cross-repo globs. One slice = one repo; cross-repo coupling is expressed as pinned `contracts` and wave order (`lib/workspace.mjs`).
- **Ownership**: per-repo head snapshot before a worker runs; out-of-ownership writes in any repo are reverted (`enforceOwnershipRepos`). The test gate runs on repo-qualified changed paths.
- **Checks**: `relay_checks` runs each repo's checks (config `checks` flat or `{repo: {...}}`, else package.json scripts) in its worktree; results keyed `<repo>:<check>` with that repo's HEAD; staleness is per repo.
- **Research/design/verify**: workers read main checkouts at `<root>/<repo>` (read-only) and the container worktrees; verification evidence goes to `.ai/<slug>/evidence/`.
- **Finish**: `pr_draft` writes `pr.md` plus `pr-<repo>.md` (cross-linked); `finalize` warns about uncommitted changes in repos. Relay never pushes or opens PRs.
- **Status UI**: slices show `[repo]`; container features are discovered from `.relay-features/*`.
- **Resume / pause / crash**: container is re-attached by slug; interrupted workers' partial writes are stashed in every repo worktree; merged-slice commits are verified per repo; the lock lives in the container.
- **Init**: `relay_init repo=<name>` runs per repo (scout features use `harness_state dir=<repo>`); root-level workspace AGENTS.md / config / verifier tools; no git ops at the root.

## Limits (honest)

- Worktrees branch from each repo's committed HEAD; uncommitted changes in main checkouts are not included. Repo worktrees have no `node_modules` (same as single-repo mode).
- Init scouts run sequentially (one active feature per orchestrator).
- A slice changes exactly one repo; a change spanning repos needs one slice per repo plus a pinned contract.
- The Copilot guard/installer is cwd-based and was **not** adapted or tested for containers.
- Container artefact history is local-only; losing `.relay-features/` loses it (code lives in the repos' `relay/<slug>` branches).
