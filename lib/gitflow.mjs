import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isLayoutFile } from "./policy.mjs";
import { scanText } from "./secrets.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lines = (s) => s.split(/\r?\n/).filter(Boolean);
const IDENT = ["-c", "user.name=Relay", "-c", "user.email=relay@localhost"];
const gitc = (cwd, ...args) => git(cwd, ...IDENT, ...args);

export const sliceBranch = (slug, slice) => `relay/${slug}--${slice}`;

/** Every path changed since `head`: commits, staged, unstaged and untracked (not ignored). */
export function changedSince(cwd, head) {
  const out = new Set();
  if (head) lines(git(cwd, "diff", "--name-only", head)).forEach((f) => out.add(f));
  lines(git(cwd, "ls-files", "--others", "--exclude-standard")).forEach((f) => out.add(f));
  return out;
}

const HARNESS_OWNED = (rel) => /(^|\/)\.git(\/|$)|(^|\/)node_modules(\/|$)|^\.ai\/lessons\.md$|(^|\/)\.lock$|\.tmp-|(^|\/)\.ai\/[^/]+\/state\.json$|\/_quarantine\/|\/verify-tools\/|\/holdout\//.test(rel);

/**
 * Revert changes made since `head` to files that `allowed(rel)` rejects (bash can bypass tool guards).
 * Tracked files are restored to their `head` content, new files removed; a revert commit is made
 * if the offending change had been committed.
 */
export function enforceOwnership(cwd, head, allowed) {
  const bad = [...changedSince(cwd, head)].filter((f) => !HARNESS_OWNED(f) && !allowed(f));
  if (!bad.length) return { reverted: [] };
  for (const f of bad) {
    let existed = true;
    try { git(cwd, "cat-file", "-e", `${head}:${f}`); } catch { existed = false; }
    if (existed) git(cwd, "checkout", head, "--", f);
    else {
      try { git(cwd, "rm", "-f", "-q", "--cached", "--ignore-unmatch", "--", f); } catch { /* untracked */ }
      fs.rmSync(path.join(cwd, f), { force: true });
    }
  }
  if (lines(git(cwd, "diff", "--cached", "--name-only")).length) {
    gitc(cwd, "commit", "-q", "-m", `relay: revert out-of-ownership changes (${bad.length} file(s))`);
  }
  return { reverted: bad };
}

/** Move files under .ai/<slug>/ that no role owns into .ai/<slug>/_quarantine/ (kept out of commits). */
export function quarantineStrays(cwd, featureDir) {
  const moved = [];
  const root = path.join(cwd, featureDir);
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const abs = path.join(d, e.name);
      const rel = path.relative(cwd, abs).split(path.sep).join("/");
      if (rel.startsWith(`${featureDir}/_quarantine`)) continue;
      if (e.isDirectory()) { walk(abs); continue; }
      if (isLayoutFile(rel, featureDir)) continue;
      const dest = path.join(root, "_quarantine", path.relative(root, abs));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(abs, dest);
      moved.push(rel);
    }
  };
  walk(root);
  for (const d of ["evidence", "reports", "verify-tools"]) { // drop emptied dirs only
    try { const p = path.join(root, d); if (fs.existsSync(p) && !fs.readdirSync(p).length) fs.rmdirSync(p); } catch { /* keep */ }
  }
  return moved;
}

/** Commit .ai/<slug> (and lessons) after a secret scan. Returns {ok, commit?, error?}. */
export function commitArtefacts(cwd, featureDir, message) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "_quarantine") walk(f); }
      else if (!/\.lock$|\.tmp-/.test(e.name) && fs.statSync(f).size < 1_000_000) {
        for (const h of scanText(fs.readFileSync(f, "utf8"))) hits.push(`${path.relative(cwd, f)}:${h.line} ${h.rule}`);
      }
    }
  };
  walk(path.join(cwd, featureDir));
  if (hits.length) return { ok: false, error: `secrets suspected, not committing:\n${hits.join("\n")}` };
  const paths = [featureDir, ".ai/lessons.md"].filter((p) => fs.existsSync(path.join(cwd, p)));
  git(cwd, "add", "-A", "--", ...paths);
  for (const f of lines(git(cwd, "diff", "--cached", "--name-only"))) {
    if (/(^|\/)\.lock$|\.tmp-|\/_quarantine\/|\/verify-tools\/|\/holdout\//.test(f)) git(cwd, "reset", "-q", "--", f);
  }
  if (!lines(git(cwd, "diff", "--cached", "--name-only")).length) return { ok: true, commit: git(cwd, "rev-parse", "HEAD"), unchanged: true };
  gitc(cwd, "commit", "-q", "-m", `${message}\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`);
  return { ok: true, commit: git(cwd, "rev-parse", "HEAD") };
}

/** Create a worktree on a sub-branch of the feature branch for one slice. */
export function addSliceWorktree(featureWt, slug, slice) {
  const wt = path.join(path.dirname(featureWt), `${slug}--${slice}`);
  const branch = sliceBranch(slug, slice);
  git(featureWt, "worktree", "prune");
  if (fs.existsSync(wt)) removeSliceWorktree(featureWt, slug, slice, { deleteBranch: true });
  try { git(featureWt, "branch", "-D", branch); } catch { /* none */ }
  git(featureWt, "worktree", "add", "-b", branch, wt, "HEAD");
  const nm = path.join(featureWt, "node_modules");
  if (fs.existsSync(nm)) { try { fs.symlinkSync(nm, path.join(wt, "node_modules"), "junction"); } catch { /* slice runs without deps */ } }
  return { path: wt, branch };
}

/** Commit leftovers in a slice worktree so the merge sees everything the slice produced. */
export function commitSliceLeftovers(wt, slice, featureDir = ".ai") {
  git(wt, "add", "-A", "--", ".", ":(exclude).ai");
  try { git(wt, "add", "-A", "--", `:(glob)${featureDir}/reports/impl-*.md`); } catch { /* no report yet */ }
  if (!lines(git(wt, "diff", "--cached", "--name-only")).length) return false;
  gitc(wt, "commit", "-q", "-m", `relay: slice ${slice} (harness commit of uncommitted work)`);
  return true;
}

/** Merge slice branches into the feature worktree in the given order; conflicts abort that slice only. */
export function mergeSlices(featureWt, slug, slices) {
  const merged = [], conflicts = [];
  for (const s of slices) {
    const branch = sliceBranch(slug, s);
    try {
      gitc(featureWt, "merge", "--no-ff", "-q", "-m", `relay: merge slice ${s}`, branch);
      merged.push({ slice: s, commit: git(featureWt, "rev-parse", "HEAD") });
    } catch (e) {
      const files = (() => { try { return lines(git(featureWt, "diff", "--name-only", "--diff-filter=U")); } catch { return []; } })();
      try { git(featureWt, "merge", "--abort"); } catch { /* nothing to abort */ }
      conflicts.push({ slice: s, files, message: String(e.stderr || e.message).slice(0, 300) });
    }
  }
  return { merged, conflicts };
}

export function removeSliceWorktree(featureWt, slug, slice, { deleteBranch = false } = {}) {
  const wt = path.join(path.dirname(featureWt), `${slug}--${slice}`);
  // drop the node_modules link first so removal can never traverse into the shared dir
  try { if (fs.lstatSync(path.join(wt, "node_modules")).isSymbolicLink()) fs.unlinkSync(path.join(wt, "node_modules")); } catch { /* no link */ }
  try { git(featureWt, "worktree", "remove", "--force", wt); } catch { fs.rmSync(wt, { recursive: true, force: true }); git(featureWt, "worktree", "prune"); }
  if (deleteBranch) { try { git(featureWt, "branch", "-D", sliceBranch(slug, slice)); } catch { /* none */ } }
}
