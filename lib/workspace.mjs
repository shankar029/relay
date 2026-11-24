import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureWorktree, branchFor } from "./worktree.mjs";
import { enforceOwnership, changedSince, addSliceWorktree, commitSliceLeftovers, mergeSlices, sliceBranch } from "./gitflow.mjs";

// Multi-repo support. See docs/multi-repo.md.
// A "workspace" is a non-git parent directory whose child directories are git repos. Each feature gets a
// local-only *container* dir (itself a tiny git repo that holds .ai/<slug>/ only) with one git worktree per
// touched repo nested inside it, so every path is repo-qualified (<repo>/src/x.js) and the single-repo
// guards, ownership globs and artefact code work unchanged on container-relative paths.

export const FEATURES_DIR = ".relay-features";
export const WS_MARK = ".relay-workspace.json";
export const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;
const IDENT = ["-c", "user.name=Relay", "-c", "user.email=relay@localhost"];
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lines = (s) => s.split(/\r?\n/).filter(Boolean);
const safe = (fn, d = null) => { try { return fn(); } catch { return d; } };

export const isGitRepo = (dir) => { try { git(dir, "rev-parse", "--show-toplevel"); return true; } catch { return false; } };
export const containerPath = (root, slug) => path.join(root, FEATURES_DIR, slug);

/** Child git repos of `root`. config.workspace.repos overrides discovery; config.workspace.exclude removes names. */
export function listRepos(root, config = {}) {
  const ws = config.workspace || {};
  let entries;
  if (Array.isArray(ws.repos) && ws.repos.length) {
    entries = ws.repos.map((r) => (typeof r === "string" ? { name: path.basename(r), dir: r } : { name: r.name || path.basename(r.path), dir: r.path }));
  } else {
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* unreadable */ }
    entries = names.filter((n) => !n.startsWith(".") && n !== "node_modules" && !n.endsWith(".relay-worktrees") && fs.existsSync(path.join(root, n, ".git"))).map((n) => ({ name: n, dir: n }));
  }
  const excl = new Set((ws.exclude || []).map(String));
  const out = [];
  for (const e of entries) {
    const abs = path.resolve(root, e.dir);
    if (excl.has(e.name) || excl.has(e.dir) || !REPO_NAME_RE.test(e.name) || !fs.existsSync(path.join(abs, ".git"))) continue;
    const hasCommit = safe(() => { git(abs, "rev-parse", "--verify", "--quiet", "HEAD"); return true; }, false);
    out.push({ name: e.name, path: abs, branch: safe(() => git(abs, "symbolic-ref", "--short", "HEAD"), "(detached)"), hasCommit, dirty: hasCommit ? lines(safe(() => git(abs, "status", "--porcelain"), "")).length : 0 });
  }
  return out;
}

/** {mode:"repo"} inside a git repo (unchanged single-repo behaviour); {mode:"workspace"} in a non-git dir with child repos. */
export function detectWorkspace(cwd, config = {}) {
  if (isGitRepo(cwd)) return { mode: "repo" };
  const repos = listRepos(path.resolve(cwd), config);
  return repos.length ? { mode: "workspace", root: path.resolve(cwd), repos } : { mode: "none" };
}

/** Container marker for a feature (present only in workspace features). */
export function readMarker(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, WS_MARK), "utf8")); } catch { return null; }
}

function addExclude(dir, wanted) {
  const p = path.resolve(dir, git(dir, "rev-parse", "--git-path", "info/exclude"));
  const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const have = new Set(cur.split(/\r?\n/));
  const add = wanted.filter((l) => !have.has(l));
  if (add.length) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, `${cur && !cur.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`); }
}

/** Create (or re-attach to) the local-only artefact container for a feature. */
export function ensureContainer(root, slug, repoNames) {
  const dir = containerPath(root, slug);
  const existed = fs.existsSync(path.join(dir, ".git"));
  fs.mkdirSync(dir, { recursive: true });
  if (!existed) {
    git(dir, "init", "-q", "-b", branchFor(slug));
    git(dir, ...IDENT, "commit", "-q", "--allow-empty", "-m", `relay: workspace feature ${slug}`);
  }
  fs.writeFileSync(path.join(dir, WS_MARK), JSON.stringify({ root, slug, repos: repoNames }, null, 2) + "\n");
  addExclude(dir, [WS_MARK, ...repoNames.map((r) => `/${r}/`)]);
  return { path: dir, branch: branchFor(slug), created: !existed };
}

/** Lazily create the repo's feature worktree (branch relay/<slug>) at <container>/<repo>. */
export function ensureRepoWorktree(root, container, slug, repo, { base, repoPath } = {}) {
  const src = repoPath || path.join(root, repo);
  const dest = path.join(container, repo);
  const wt = ensureWorktree(src, slug, { base, dest });
  addExclude(container, [`/${repo}/`]);
  return { ...wt, repo };
}

/** Names of repos that currently have a feature worktree nested in `dir` (container or slice container). */
export function repoNamesIn(dir, names) {
  return names.filter((n) => fs.existsSync(path.join(dir, n, ".git")));
}

export const snapshotHeads = (dir, names) => Object.fromEntries(repoNamesIn(dir, names).map((n) => [n, safe(() => git(path.join(dir, n), "rev-parse", "HEAD"))]).filter(([, h]) => h));

/** Container-relative (repo-qualified) paths changed since the per-repo heads. */
export function changedSinceRepos(dir, heads) {
  const out = new Set();
  for (const [n, h] of Object.entries(heads)) for (const f of changedSince(path.join(dir, n), h)) out.add(`${n}/${f}`);
  return out;
}

/** Per-repo ownership revert; `allowed` receives repo-qualified paths. */
export function enforceOwnershipRepos(dir, heads, allowed) {
  const reverted = [];
  for (const [n, h] of Object.entries(heads)) {
    reverted.push(...enforceOwnership(path.join(dir, n), h, (f) => allowed(`${n}/${f}`)).reverted.map((f) => `${n}/${f}`));
  }
  return reverted;
}

/** Slice container (artefacts, sub-branch of the container) with a nested slice worktree of `repo`. */
export function addSliceWorktreeWs(container, slug, slice, repo) {
  const s = addSliceWorktree(container, slug, slice);
  const repoWt = path.join(container, repo);
  const dest = path.join(s.path, repo);
  const branch = sliceBranch(slug, slice);
  git(repoWt, "worktree", "prune");
  safe(() => git(repoWt, "branch", "-D", branch));
  git(repoWt, "worktree", "add", "-b", branch, dest, "HEAD");
  const nm = path.join(repoWt, "node_modules");
  if (fs.existsSync(nm)) safe(() => fs.symlinkSync(nm, path.join(dest, "node_modules"), "junction"));
  addExclude(s.path, [`/${repo}/`]);
  return { path: s.path, branch, repo };
}

export function commitSliceLeftoversWs(sliceDir, slice, repo, featureDir) {
  const a = commitSliceLeftovers(sliceDir, slice, featureDir);
  const b = repo && fs.existsSync(path.join(sliceDir, repo, ".git")) ? commitSliceLeftovers(path.join(sliceDir, repo), slice, ".ai") : false;
  return a || b;
}

/** Merge each slice's repo branch into <container>/<repo>, then its artefact branch into the container. */
export function mergeSlicesWs(container, slug, slices) {
  const merged = [], conflicts = [];
  for (const { slice, repo } of slices) {
    const repoWt = path.join(container, repo);
    const r = mergeSlices(repoWt, slug, [slice]);
    if (r.conflicts.length) { conflicts.push({ ...r.conflicts[0], repo }); continue; }
    const c = mergeSlices(container, slug, [slice]);
    if (c.conflicts.length) { conflicts.push({ ...c.conflicts[0], repo }); continue; }
    merged.push({ slice, repo, commit: safe(() => git(repoWt, "rev-parse", "HEAD")), containerCommit: c.merged[0]?.commit });
  }
  return { merged, conflicts };
}

export function removeSliceWorktreeWs(container, slug, slice, repo, { deleteBranch = false } = {}) {
  const sliceDir = path.join(path.dirname(container), `${slug}--${slice}`);
  const repoWt = path.join(container, repo);
  const dest = path.join(sliceDir, repo);
  try { if (fs.lstatSync(path.join(dest, "node_modules")).isSymbolicLink()) fs.unlinkSync(path.join(dest, "node_modules")); } catch { /* no link */ }
  try { git(repoWt, "worktree", "remove", "--force", dest); } catch { fs.rmSync(dest, { recursive: true, force: true }); safe(() => git(repoWt, "worktree", "prune")); }
  if (deleteBranch) safe(() => git(repoWt, "branch", "-D", sliceBranch(slug, slice)));
  return sliceDir;
}

/** Park a killed worker's partial writes in every repo worktree of `dir`. Returns the repos that were stashed. */
export function stashPartialRepos(dir, names, label) {
  const out = [];
  for (const n of repoNamesIn(dir, names)) {
    const wt = path.join(dir, n);
    if (lines(safe(() => git(wt, "status", "--porcelain", "--", ".", ":(exclude).ai"), "")).length) {
      git(wt, "stash", "push", "-u", "-m", `relay-interrupted: ${label}`, "--", ".", ":(exclude).ai");
      out.push(n);
    }
  }
  return out;
}

// ---- plan ----

export const repoOfPath = (p, names) => { const seg = String(p).replace(/^\.\//, "").split("/")[0]; return names.includes(seg) ? seg : null; };

/**
 * Workspace plan rules (on top of checkPlan): every slice names one repo; all files.own/tests globs live under
 * "<repo>/"; plan.repos lists exactly the repos touched; cross-repo slices that run in the same wave need pinned
 * contracts for anything they share (already enforced by checkPlan's contract rule).
 */
export function checkWorkspacePlan(plan, repoNames) {
  const errors = [];
  const used = new Set();
  for (const s of plan.slices) {
    if (!s.repo) { errors.push(`slice ${s.id}: workspace plans need slice.repo (one of ${repoNames.join(", ")})`); continue; }
    if (!repoNames.includes(s.repo)) { errors.push(`slice ${s.id}: unknown repo "${s.repo}" (known: ${repoNames.join(", ")})`); continue; }
    used.add(s.repo);
    for (const g of [...s.files.own, ...(s.tests || [])]) {
      if (!g.startsWith(`${s.repo}/`)) errors.push(`slice ${s.id}: "${g}" must be repo-qualified under "${s.repo}/" (a slice owns files in exactly one repo)`);
    }
    for (const g of s.files.read || []) if (repoOfPath(g, repoNames) === null && !g.startsWith(".ai/")) errors.push(`slice ${s.id}: read glob "${g}" must start with a repo name`);
  }
  const declared = new Set(plan.repos || []);
  for (const r of used) if (!declared.has(r)) errors.push(`plan.repos must list "${r}" (used by a slice)`);
  for (const r of declared) if (!used.has(r)) errors.push(`plan.repos lists "${r}" but no slice touches it`);
  return errors;
}

// ---- checks ----

/** Per-repo check commands: config.checks[repo] (object) > flat config.checks > package.json scripts. */
export function repoChecks(repoDir, repo, configChecks) {
  if (configChecks && typeof configChecks === "object") {
    if (configChecks[repo] && typeof configChecks[repo] === "object") return configChecks[repo];
    const flat = Object.fromEntries(Object.entries(configChecks).filter(([, v]) => typeof v === "string"));
    if (Object.keys(flat).length) return flat;
  }
  try {
    const scripts = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8")).scripts || {};
    return Object.fromEntries(["build", "typecheck", "lint", "test"].filter((n) => scripts[n]).map((n) => [n, `npm run ${n}`]));
  } catch { return {}; }
}

export const requiredWorkspaceChecks = (repos, base) => repos.flatMap((r) => base.map((n) => `${r}:${n}`));

/** Staleness of required `<repo>:<check>` results against each repo's current HEAD. */
export function checkStaleness(container, state, repos, base) {
  const out = [];
  for (const r of repos) for (const n of base) {
    const res = state.checkResults?.[`${r}:${n}`];
    const head = safe(() => git(path.join(container, r), "rev-parse", "HEAD"));
    if (res && head && res.head !== head) out.push(`required check "${r}:${n}" is stale (ran on ${String(res.head).slice(0, 8)}, ${r} HEAD is ${head.slice(0, 8)}); re-run relay_checks`);
  }
  return out;
}

// ---- finish ----

/** Per-repo commit set: base..HEAD commits, diffstat, files, uncommitted paths. */
export function repoSummaries(container, wsState) {
  return Object.entries(wsState?.repos || {}).map(([name, info]) => {
    const wt = path.join(container, name);
    const base = info.baseSha || info.base || "HEAD";
    return {
      name, branch: info.branch, base: info.base || "HEAD", baseSha: info.baseSha,
      commits: lines(safe(() => git(wt, "log", "--oneline", `${base}..HEAD`), "")),
      diffStat: safe(() => git(wt, "diff", "--stat", `${base}...HEAD`), ""),
      files: lines(safe(() => git(wt, "diff", "--name-only", `${base}...HEAD`), "")),
      dirty: lines(safe(() => git(wt, "status", "--porcelain", "--", ".", ":(exclude).ai"), "")),
    };
  });
}

/** PR text for one repo, cross-linked to the sibling repos' PRs. */
export function renderRepoPr({ slug, title, summary, repo, summaries, root }) {
  const me = summaries.find((s) => s.name === repo);
  const others = summaries.filter((s) => s.name !== repo);
  const repoDir = path.join(root, repo);
  return [
    `# ${title} (${repo})`,
    `Part of cross-repo feature \`${slug}\`.`,
    `## Summary\n${summary}`,
    `## Related PRs (fill in after opening)\n${others.length ? others.map((o) => `- ${o.name}: <PR URL> (branch \`${o.branch}\`)`).join("\n") : "- none (single repo)"}`,
    `## Commits\n${me.commits.map((c) => `- ${c}`).join("\n") || "- (none)"}\n\n\`\`\`\n${me.diffStat}\n\`\`\``,
    `## Create the PR manually (if relay_pr is disabled or fails)\n\`\`\`sh\ncd ${JSON.stringify(repoDir)}\ngit push -u origin ${me.branch}\ngh pr create --base ${me.base === "HEAD" ? "<default-branch>" : me.base} --head ${me.branch} --title ${JSON.stringify(`${title} (${repo})`)} --body-file <path to pr-${repo}.md>\n\`\`\``,
  ].join("\n\n") + "\n";
}

/** Replace renderPr's single-repo "Create the PR" block with per-repo guidance. */
export function multiRepoCreateSection(summaries, featureDir) {
  const body = summaries.map((s) => `- **${s.name}**: branch \`${s.branch}\`, ${s.commits.length} commit(s), ${s.files.length} file(s); PR text: \`${featureDir}/pr-${s.name}.md\`${s.dirty.length ? ` (UNCOMMITTED: ${s.dirty.slice(0, 5).join(", ")})` : ""}`).join("\n");
  return `## Repos and PRs (not run by Relay)\nOne PR per repo; each \`pr-<repo>.md\` lists the sibling PRs to cross-link. relay_pr can push and open them after you confirm.\n${body}`;
}
