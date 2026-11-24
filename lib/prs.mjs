// Final step: push relay/<slug> and open one PR per affected repo. Pure logic with an injectable command
// runner so it can be tested with a mock gh/git. Safety rules enforced here, not in prompts:
//   - only branches named relay/<slug> are pushed, never with --force, never the default branch
//   - one PR per repo; a PR already recorded in state or found via `gh pr list --head` is reused (idempotent)
//   - sibling PRs are cross-linked by editing each body after all PRs exist
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultRunner(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", shell: false });
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || (r.error ? String(r.error.message) : "") };
}

export function prConfig(config) {
  const c = config?.pr || {};
  return { auto: c.auto !== false, draft: c.draft === true };
}

/** Repos the feature touched: workspace repos with commits, or the single worktree. */
export function prTargets(state, featureAbsDir, summaries) {
  if (state.workspace) {
    return Object.entries(state.workspace.repos || {})
      .map(([name, info]) => ({ name, dir: info.path, branch: info.branch, base: info.base, baseSha: info.baseSha, bodyFile: path.join(featureAbsDir, `pr-${name}.md`) }))
      .filter((t) => !summaries || (summaries.find((s) => s.name === t.name)?.commits.length ?? 0) > 0);
  }
  if (state.worktree) return [{ name: "", dir: state.worktree.path, branch: state.worktree.branch, base: state.worktree.base, baseSha: state.worktree.baseSha, bodyFile: path.join(featureAbsDir, "pr.md") }];
  return [];
}

/** Body for gh: drop the "Create the PR manually" how-to, which is moot once the PR exists. */
export function cleanBody(md) {
  return md.replace(/\n*## Create the PR[\s\S]*$/, "\n").replace(/\n*## Repos and PRs \(not run by Relay\)[\s\S]*$/, "\n");
}

export function linkBody(md, urls) {
  let out = md.replace(/## Related PRs \(fill in after opening\)/, "## Related PRs");
  for (const [name, url] of Object.entries(urls)) out = out.replace(new RegExp(`^- ${name}: <PR URL>`, "m"), `- ${name}: ${url}`);
  return out;
}

const fail = (t, error) => ({ name: t.name, branch: t.branch, status: "failed", error });

function safeBranch(t, slug) {
  return t.branch === `relay/${slug}`;
}

/** Read-only facts per target, used for the approval summary. */
export function planPrs({ targets, slug, run = defaultRunner, existing = {} }) {
  return targets.map((t) => {
    const info = { name: t.name, dir: t.dir, branch: t.branch, existing: existing[t.name || "_"] || null, problems: [] };
    if (!safeBranch(t, slug)) info.problems.push(`branch ${t.branch} is not relay/${slug}; refusing`);
    const remote = run("git", ["remote", "get-url", "origin"], { cwd: t.dir });
    info.remote = remote.code === 0 ? remote.stdout.trim() : null;
    if (!info.remote) info.problems.push("no 'origin' remote");
    const sha = run("git", ["rev-parse", "--short", "HEAD"], { cwd: t.dir });
    info.head = sha.code === 0 ? sha.stdout.trim() : null;
    const stat = run("git", ["diff", "--shortstat", `${t.baseSha || (t.base && t.base !== "HEAD" ? t.base : "HEAD")}...HEAD`], { cwd: t.dir });
    info.diff = stat.code === 0 ? stat.stdout.trim() : "";
    return info;
  });
}

export function ghAvailable(run = defaultRunner) {
  return run("gh", ["--version"], {}).code === 0;
}

export function openPrs({ targets, slug, title, run = defaultRunner, existing = {}, draft = false, readFile = (f) => fs.readFileSync(f, "utf8"), writeFile = (f, c) => fs.writeFileSync(f, c) }) {
  const results = [];
  if (!ghAvailable(run)) return targets.map((t) => fail(t, "gh CLI not found or not usable; leave pr.md and open the PR manually"));
  for (const t of targets) {
    const key = t.name || "_";
    const label = t.name ? `${title} (${t.name})` : title;
    if (!safeBranch(t, slug)) { results.push(fail(t, `refusing to push ${t.branch}: only relay/${slug} is allowed`)); continue; }
    if (existing[key]?.url) { results.push({ name: t.name, branch: t.branch, status: "exists", url: existing[key].url }); continue; }
    const remote = run("git", ["remote", "get-url", "origin"], { cwd: t.dir });
    if (remote.code !== 0) { results.push(fail(t, "no 'origin' remote; push and open the PR manually from pr text")); continue; }
    const found = run("gh", ["pr", "list", "--head", t.branch, "--state", "open", "--json", "url", "--limit", "1"], { cwd: t.dir });
    if (found.code === 0) {
      let url; try { url = JSON.parse(found.stdout || "[]")[0]?.url; } catch { /* ignore */ }
      if (url) { results.push({ name: t.name, branch: t.branch, status: "exists", url }); continue; }
    }
    const base = resolveBase(t, run);
    const push = run("git", ["push", "-u", "origin", `${t.branch}:${t.branch}`], { cwd: t.dir });
    if (push.code !== 0) { results.push(fail(t, `git push failed: ${push.stderr.trim().slice(0, 300)}`)); continue; }
    const tmp = t.bodyFile;
    let body;
    try { body = cleanBody(readFile(tmp)); } catch (e) { results.push(fail(t, `cannot read ${tmp}: ${e.message}`)); continue; }
    const bodyOut = path.join(os.tmpdir(), `relay-pr-body-${process.pid}-${t.name || "main"}.md`);
    writeFile(bodyOut, body);
    const args = ["pr", "create", "--base", base, "--head", t.branch, "--title", label, "--body-file", bodyOut];
    if (draft) args.push("--draft");
    const created = run("gh", args, { cwd: t.dir });
    const url = (created.stdout.match(/https?:\/\/\S+/) || [])[0];
    if (created.code !== 0 || !url) { results.push(fail(t, `gh pr create failed: ${(created.stderr || created.stdout).trim().slice(0, 300)}`)); continue; }
    results.push({ name: t.name, branch: t.branch, status: "created", url, base });
  }
  // cross-link siblings now that every URL is known
  const urls = Object.fromEntries(results.filter((r) => r.url && r.name).map((r) => [r.name, r.url]));
  if (Object.keys(urls).length > 1) {
    for (const r of results) {
      if (r.status !== "created") continue;
      const t = targets.find((x) => x.name === r.name);
      const others = Object.fromEntries(Object.entries(urls).filter(([n]) => n !== r.name));
      try {
        const bodyOut = path.join(os.tmpdir(), `relay-pr-body-${process.pid}-${t.name}.md`);
        writeFile(bodyOut, linkBody(cleanBody(readFile(t.bodyFile)), others));
        const ed = run("gh", ["pr", "edit", r.url, "--body-file", bodyOut], { cwd: t.dir });
        if (ed.code !== 0) r.linkWarning = `could not add sibling links: ${ed.stderr.trim().slice(0, 200)}`;
      } catch (e) { r.linkWarning = e.message; }
    }
  }
  return results;
}

function resolveBase(t, run) {
  if (t.base && t.base !== "HEAD") return t.base;
  const r = run("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], { cwd: t.dir });
  const b = r.code === 0 ? r.stdout.trim() : "";
  return b || "main";
}

export function renderPlan(plan) {
  return plan.map((p) => `- ${p.name || "repo"}: ${p.branch} @ ${p.head || "?"} -> ${p.remote || "NO REMOTE"}${p.diff ? ` (${p.diff})` : ""}${p.existing ? ` [PR exists: ${p.existing.url}]` : ""}${p.problems.length ? ` !! ${p.problems.join("; ")}` : ""}`).join("\n");
}
