import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export const branchFor = (slug) => `relay/${slug}`;

export function repoTop(cwd) {
  return path.resolve(git(cwd, "rev-parse", "--show-toplevel"));
}

// Default location: sibling dir "<repo>.relay-worktrees/<slug>", so the repo itself stays clean.
export function worktreePathFor(top, slug) {
  return path.join(path.dirname(top), `${path.basename(top)}.relay-worktrees`, slug);
}

// Parse `git worktree list --porcelain` into [{path, branch, head}].
export function listWorktrees(cwd) {
  const out = git(cwd, "worktree", "list", "--porcelain");
  return out.split(/\r?\n\r?\n/).filter(Boolean).map((blk) => {
    const w = {};
    for (const l of blk.split(/\r?\n/)) {
      if (l.startsWith("worktree ")) w.path = path.resolve(l.slice(9));
      else if (l.startsWith("HEAD ")) w.head = l.slice(5);
      else if (l.startsWith("branch ")) w.branch = l.slice(7).replace(/^refs\/heads\//, "");
    }
    return w;
  });
}

export const findWorktree = (cwd, slug) => listWorktrees(cwd).find((w) => w.branch === branchFor(slug) && fs.existsSync(w.path));

const branchExists = (cwd, b) => {
  try { git(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`); return true; } catch { return false; }
};

/**
 * Create (or re-attach to) the feature worktree on branch relay/<slug>.
 * Existing worktree => reuse. Branch without worktree (e.g. deleted dir) => prune and re-add it.
 * New => branch off `base` (default HEAD).
 */
export function ensureWorktree(cwd, slug, { base } = {}) {
  const top = repoTop(cwd);
  const branch = branchFor(slug);
  const existing = findWorktree(top, slug);
  if (existing) return { path: existing.path, branch, base: base || "HEAD", created: false };
  const wt = worktreePathFor(top, slug);
  if (fs.existsSync(wt)) throw new Error(`path ${wt} exists but is not a worktree of branch ${branch}`);
  git(top, "worktree", "prune");
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  if (branchExists(top, branch)) git(top, "worktree", "add", wt, branch);
  else git(top, "worktree", "add", "-b", branch, wt, base || "HEAD");
  const baseSha = git(top, "rev-parse", base || "HEAD");
  return { path: wt, branch, base: base || "HEAD", baseSha, created: true };
}

// Keep harness-only files (locks, temp writes) out of commits, via the worktree's exclude file.
export function excludeHarnessFiles(wtPath) {
  const p = path.resolve(wtPath, git(wtPath, "rev-parse", "--git-path", "info/exclude"));
  const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const want = [".ai/*/.lock", ".ai/.lock", ".ai/*/_quarantine/", "*.tmp-*"].filter((l) => !cur.split(/\r?\n/).includes(l));
  if (want.length) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${cur && !cur.endsWith("\n") ? "\n" : ""}${want.join("\n")}\n`);
  }
}
