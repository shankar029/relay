import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as W from "../lib/workspace.mjs";
import { discoverFeatures, buildSnapshot } from "../lib/status.mjs";
import { matchesAny } from "../lib/policy.mjs";

const IDENT = ["-c", "user.name=T", "-c", "user.email=t@t"];
const git = (cwd, ...a) => execFileSync("git", [...IDENT, ...a], { cwd, encoding: "utf8" }).trim();
function mkRepo(root, name, files) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  git(d, "init", "-q", "-b", "main");
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  git(d, "add", "-A"); git(d, "commit", "-q", "-m", "init");
  return d;
}
function mkWs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ws-"));
  mkRepo(root, "api", { "src/a.js": "a\n", "package.json": JSON.stringify({ scripts: { test: "node -e 0" } }) });
  mkRepo(root, "web", { "src/w.js": "w\n" });
  fs.mkdirSync(path.join(root, "notes")); // not a repo
  return root;
}

test("detectWorkspace: child repos in a non-git parent; single repo unchanged", () => {
  const root = mkWs();
  const d = W.detectWorkspace(root);
  assert.equal(d.mode, "workspace");
  assert.deepEqual(d.repos.map((r) => r.name).sort(), ["api", "web"]);
  assert.equal(W.detectWorkspace(path.join(root, "api")).mode, "repo");
  assert.equal(W.detectWorkspace(path.join(root, "notes")).mode, "none");
  const ex = W.detectWorkspace(root, { workspace: { exclude: ["web"] } });
  assert.deepEqual(ex.repos.map((r) => r.name), ["api"]);
});

test("container + lazy repo worktrees; ownership revert is per repo and repo-qualified", () => {
  const root = mkWs();
  const c = W.ensureContainer(root, "feat", ["api", "web"]);
  assert.ok(fs.existsSync(path.join(c.path, ".git")));
  const again = W.ensureContainer(root, "feat", ["api", "web"]);
  assert.equal(again.created, false);
  assert.deepEqual(W.repoNamesIn(c.path, ["api", "web"]), []);
  W.ensureRepoWorktree(root, c.path, "feat", "api");
  W.ensureRepoWorktree(root, c.path, "feat", "web");
  assert.equal(git(path.join(c.path, "api"), "rev-parse", "--abbrev-ref", "HEAD"), "relay/feat");
  assert.deepEqual(W.repoNamesIn(c.path, ["api", "web"]), ["api", "web"]);
  // the main checkout is untouched and not on the feature branch
  assert.equal(git(path.join(root, "api"), "rev-parse", "--abbrev-ref", "HEAD"), "main");

  const heads = W.snapshotHeads(c.path, ["api", "web"]);
  fs.writeFileSync(path.join(c.path, "api", "src", "ok.js"), "ok\n");
  fs.writeFileSync(path.join(c.path, "web", "src", "stray.js"), "stray\n");
  const owned = ["api/src/**"];
  const rev = W.enforceOwnershipRepos(c.path, heads, (f) => f.startsWith(".ai/") || matchesAny(owned, f));
  assert.deepEqual(rev, ["web/src/stray.js"]);
  assert.ok(fs.existsSync(path.join(c.path, "api", "src", "ok.js")));
  assert.ok(!fs.existsSync(path.join(c.path, "web", "src", "stray.js")));
  assert.ok(W.changedSinceRepos(c.path, heads).has("api/src/ok.js"));
});

test("parallel slices in different repos merge back per repo and clean up", () => {
  const root = mkWs();
  const c = W.ensureContainer(root, "feat", ["api", "web"]);
  W.ensureRepoWorktree(root, c.path, "feat", "api");
  W.ensureRepoWorktree(root, c.path, "feat", "web");
  const s1 = W.addSliceWorktreeWs(c.path, "feat", "s-api", "api");
  const s2 = W.addSliceWorktreeWs(c.path, "feat", "s-web", "web");
  fs.writeFileSync(path.join(s1.path, "api", "src", "new.js"), "n\n");
  fs.writeFileSync(path.join(s2.path, "web", "src", "new.js"), "m\n");
  W.commitSliceLeftoversWs(s1.path, "s-api", "api", ".ai/feat");
  W.commitSliceLeftoversWs(s2.path, "s-web", "web", ".ai/feat");
  const r = W.mergeSlicesWs(c.path, "feat", [{ slice: "s-api", repo: "api" }, { slice: "s-web", repo: "web" }]);
  assert.equal(r.conflicts.length, 0, JSON.stringify(r.conflicts));
  assert.deepEqual(r.merged.map((m) => m.repo), ["api", "web"]);
  assert.ok(fs.existsSync(path.join(c.path, "api", "src", "new.js")));
  assert.ok(fs.existsSync(path.join(c.path, "web", "src", "new.js")));
  W.removeSliceWorktreeWs(c.path, "feat", "s-api", "api", { deleteBranch: true });
  assert.ok(!fs.existsSync(path.join(s1.path, "api")));
});

test("checkWorkspacePlan: repo required, globs qualified, plan.repos exact", () => {
  const plan = (s, repos) => ({ repos, slices: [s] });
  const good = { id: "x", repo: "api", files: { own: ["api/src/**"] }, tests: ["api/test/x.test.js"] };
  assert.deepEqual(W.checkWorkspacePlan(plan(good, ["api"]), ["api", "web"]), []);
  assert.match(W.checkWorkspacePlan(plan({ ...good, repo: undefined }, ["api"]), ["api"])[0], /need slice.repo/);
  assert.match(W.checkWorkspacePlan(plan({ ...good, files: { own: ["web/src/**"] } }, ["api"]), ["api", "web"])[0], /repo-qualified/);
  assert.match(W.checkWorkspacePlan(plan(good, ["api", "web"]), ["api", "web"])[0], /no slice touches/);
  assert.match(W.checkWorkspacePlan(plan({ ...good, repo: "zzz" }, ["zzz"]), ["api"])[0], /unknown repo/);
});

test("per-repo checks and staleness", () => {
  const root = mkWs();
  const c = W.ensureContainer(root, "feat", ["api", "web"]);
  W.ensureRepoWorktree(root, c.path, "feat", "api");
  assert.deepEqual(W.repoChecks(path.join(root, "api"), "api", undefined), { test: "npm run test" });
  assert.deepEqual(W.repoChecks(path.join(root, "web"), "web", { api: { test: "x" }, web: { test: "y" } }), { test: "y" });
  assert.deepEqual(W.requiredWorkspaceChecks(["api", "web"], ["test"]), ["api:test", "web:test"]);
  const head = git(path.join(c.path, "api"), "rev-parse", "HEAD");
  const st = { checkResults: { "api:test": { ok: true, head } } };
  assert.deepEqual(W.checkStaleness(c.path, st, ["api"], ["test"]), []);
  fs.writeFileSync(path.join(c.path, "api", "x.txt"), "1");
  git(path.join(c.path, "api"), "add", "-A"); git(path.join(c.path, "api"), "commit", "-q", "-m", "more");
  assert.match(W.checkStaleness(c.path, st, ["api"], ["test"])[0], /api:test.*stale/);
});

test("per-repo PR text is cross-linked; never pushes", () => {
  const root = mkWs();
  const c = W.ensureContainer(root, "feat", ["api", "web"]);
  for (const r of ["api", "web"]) W.ensureRepoWorktree(root, c.path, "feat", r);
  fs.writeFileSync(path.join(c.path, "api", "n.txt"), "1"); git(path.join(c.path, "api"), "add", "-A"); git(path.join(c.path, "api"), "commit", "-q", "-m", "api change");
  const ws = { root, repos: { api: { path: path.join(root, "api"), branch: "relay/feat", base: "main", baseSha: git(path.join(root, "api"), "rev-parse", "main") }, web: { path: path.join(root, "web"), branch: "relay/feat", base: "main", baseSha: git(path.join(root, "web"), "rev-parse", "main") } } };
  const sums = W.repoSummaries(c.path, ws);
  assert.equal(sums.find((s) => s.name === "api").commits.length, 1);
  assert.equal(sums.find((s) => s.name === "web").commits.length, 0);
  const md = W.renderRepoPr({ slug: "feat", title: "T", summary: "S", repo: "api", summaries: sums, root });
  assert.match(md, /web: <PR URL>/);
  assert.match(md, /not run by Relay/);
  assert.match(W.multiRepoCreateSection(sums, ".ai/feat"), /pr-api\.md/);
});

test("status: repo tag on slices and container discovery", () => {
  const root = mkWs();
  const c = W.ensureContainer(root, "feat", ["api"]);
  fs.mkdirSync(path.join(c.path, ".ai", "feat"), { recursive: true });
  fs.writeFileSync(path.join(c.path, ".ai", "feat", "state.json"), JSON.stringify({ slug: "feat", phase: "implement" }));
  fs.mkdirSync(path.join(root, ".relay-features", "feat--s1", ".ai", "feat"), { recursive: true });
  fs.writeFileSync(path.join(root, ".relay-features", "feat--s1", ".ai", "feat", "state.json"), JSON.stringify({ slug: "feat", phase: "implement" }));
  const found = discoverFeatures([root]);
  assert.equal(found.length, 1);
  assert.equal(found[0].root, c.path);
  const snap = buildSnapshot({ state: { phase: "implement", slices: {}, approvals: {} }, plan: { slices: [{ id: "s1", repo: "api" }] }, jobs: [] });
  assert.match(snap.children[0].label, /\[api\]/);
});
