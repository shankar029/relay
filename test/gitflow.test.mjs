import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { enforceOwnership, quarantineStrays, commitArtefacts, addSliceWorktree, commitSliceLeftovers, mergeSlices, removeSliceWorktree, changedSince } from "../lib/gitflow.mjs";
import { testGate, checkRead, isLayoutFile, checkWrite } from "../lib/policy.mjs";
import { phaseProblems, renderPr } from "../lib/gates.mjs";

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const w = (root, rel, text = "x\n") => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
function mkRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-gf-")));
  const repo = path.join(dir, "app");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  w(repo, "src/a.js", "a\n");
  w(repo, "src/b.js", "b\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  return { dir, repo };
}
const FD = ".ai/f";

test("enforceOwnership reverts tracked edits and removes new files outside ownership", () => {
  const { dir, repo } = mkRepo();
  try {
    const head = git(repo, "rev-parse", "HEAD");
    w(repo, "src/a.js", "mine\n");
    w(repo, "src/b.js", "hacked\n");
    w(repo, "src/evil.js");
    w(repo, `${FD}/spec.md`, "ok spec text here ok");
    const { reverted } = enforceOwnership(repo, head, (f) => f === "src/a.js" || f.startsWith(".ai/"));
    assert.deepEqual(reverted.sort(), ["src/b.js", "src/evil.js"]);
    assert.equal(fs.readFileSync(path.join(repo, "src/b.js"), "utf8").replace(/\r/g, ""), "b\n");
    assert.equal(fs.existsSync(path.join(repo, "src/evil.js")), false);
    assert.equal(fs.readFileSync(path.join(repo, "src/a.js"), "utf8").replace(/\r/g, ""), "mine\n");
    assert.equal(fs.existsSync(path.join(repo, FD, "spec.md")), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("enforceOwnership reverts out-of-ownership changes that were committed", () => {
  const { dir, repo } = mkRepo();
  try {
    const head = git(repo, "rev-parse", "HEAD");
    w(repo, "src/b.js", "sneaky\n");
    git(repo, "commit", "-qam", "bash commit");
    const { reverted } = enforceOwnership(repo, head, (f) => f === "src/a.js");
    assert.deepEqual(reverted, ["src/b.js"]);
    assert.equal(fs.readFileSync(path.join(repo, "src/b.js"), "utf8").replace(/\r/g, ""), "b\n");
    assert.equal(git(repo, "status", "--porcelain"), "");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("test gate: fails without test changes, passes with them (via changedSince)", () => {
  const { dir, repo } = mkRepo();
  try {
    const head = git(repo, "rev-parse", "HEAD");
    w(repo, "src/a.js", "new behaviour\n");
    assert.equal(testGate([...changedSince(repo, head)]).length, 1);
    w(repo, "test/a.test.js", "t\n");
    assert.deepEqual(testGate([...changedSince(repo, head)]), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("quarantineStrays moves non-layout files and keeps layout files", () => {
  const { dir, repo } = mkRepo();
  try {
    for (const f of ["spec.md", "state.json", "reports/impl-s1.md", "reports/verify-1.json", "evidence/e1.txt", "verify-tools/verify-1.mjs"]) w(repo, `${FD}/${f}`);
    for (const f of ["verify-tools/PLAN.md", "finalize-report.mjs", "readme-access-blocked.json", "evidence/../notes.md"]) w(repo, `${FD}/${f}`);
    const moved = quarantineStrays(repo, FD);
    assert.deepEqual(moved.sort(), [`${FD}/finalize-report.mjs`, `${FD}/notes.md`, `${FD}/readme-access-blocked.json`, `${FD}/verify-tools/PLAN.md`].sort());
    assert.equal(fs.existsSync(path.join(repo, FD, "_quarantine/finalize-report.mjs")), true);
    assert.equal(fs.existsSync(path.join(repo, FD, "spec.md")), true);
    assert.equal(fs.existsSync(path.join(repo, FD, "verify-tools/verify-1.mjs")), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("commitArtefacts commits .ai/<slug> without lock/quarantine and refuses secrets", () => {
  const { dir, repo } = mkRepo();
  try {
    w(repo, `${FD}/spec.md`, "spec text here for the feature");
    w(repo, `${FD}/.lock`, "lock");
    w(repo, `${FD}/_quarantine/x.md`, "q");
    w(repo, `${FD}/state.json.tmp-123`, "{}");
    w(repo, ".ai/lessons.md", "lesson\n");
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), ".ai/*/.lock\n.ai/*/_quarantine/\n*.tmp-*\n");
    const r = commitArtefacts(repo, FD, "relay: artefacts");
    assert.equal(r.ok, true);
    const files = git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").sort();
    assert.deepEqual(files, [".ai/lessons.md", `${FD}/spec.md`].sort());
    assert.match(git(repo, "log", "-1", "--format=%B"), /Co-authored-by: Copilot App/);
    w(repo, `${FD}/notes.md`, "key = AKIAIOSFODNN7EXAMPLE\n");
    const bad = commitArtefacts(repo, FD, "relay: again");
    assert.equal(bad.ok, false);
    assert.match(bad.error, /secrets suspected/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("parallel slice worktrees merge in plan order; conflicts abort only that slice", () => {
  const { dir, repo } = mkRepo();
  try {
    git(repo, "checkout", "-q", "-b", "relay/f");
    const s1 = addSliceWorktree(repo, "f", "s1");
    const s2 = addSliceWorktree(repo, "f", "s2");
    const s3 = addSliceWorktree(repo, "f", "s3");
    assert.notEqual(s1.path, repo);
    w(s1.path, "src/one.js", "1\n"); w(s1.path, `${FD}/reports/impl-s1.md`, "report one");
    w(s2.path, "src/two.js", "2\n");
    w(s3.path, "src/one.js", "conflicting\n");
    for (const [wt, s] of [[s1.path, "s1"], [s2.path, "s2"], [s3.path, "s3"]]) assert.equal(commitSliceLeftovers(wt, s, FD), true);
    const { merged, conflicts } = mergeSlices(repo, "f", ["s1", "s2", "s3"]);
    assert.deepEqual(merged.map((m) => m.slice), ["s1", "s2"]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].slice, "s3");
    assert.deepEqual(conflicts[0].files, ["src/one.js"]);
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(fs.existsSync(path.join(repo, "src/two.js")), true);
    assert.equal(fs.existsSync(path.join(repo, FD, "reports/impl-s1.md")), true);
    removeSliceWorktree(repo, "f", "s1", { deleteBranch: true });
    assert.equal(fs.existsSync(s1.path), false);
    assert.equal(fs.existsSync(s3.path), true); // conflicting slice kept for re-delegation
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("policy: README readable by researcher/architect/verifier/reviewer; layout and verifier writes", () => {
  for (const role of ["relay-researcher", "relay-architect", "relay-verifier", "relay-reviewer"]) assert.ok(!checkRead({ role, rel: "README.md" }), role);
  assert.ok(!checkRead({ role: "relay-implementor", rel: "README.md" }));
  assert.ok(checkRead({ role: "relay-spec-writer", rel: "README.md" }));
  assert.ok(isLayoutFile(`${FD}/pr.md`, FD));
  assert.ok(isLayoutFile(`${FD}/evidence/a/b.txt`, FD));
  assert.ok(!isLayoutFile(`${FD}/finalize-report.mjs`, FD));
  assert.ok(!isLayoutFile(`${FD}/verify-tools/PLAN.md`, FD));
  assert.ok(isLayoutFile(`${FD}/verify-tools/verify-1.mjs`, FD));
});

test("phaseProblems gates on content, approvals, merged slices and evidence", () => {
  const { dir, repo } = mkRepo();
  try {
    const schemas = { features: { type: "object" }, plan: { type: "object" } };
    const st = { approvals: {}, slices: {}, steps: {} };
    const base = { cwd: repo, featureDir: FD, schemas };
    assert.ok(phaseProblems({ ...base, phase: "spec-approval", state: st }).some((p) => /spec.md/.test(p)));
    assert.ok(phaseProblems({ ...base, phase: "design", state: st }).some((p) => /not been approved/.test(p)));
    assert.ok(phaseProblems({ ...base, phase: "done", state: st }).some((p) => /pr.md lacks/.test(p)));
    const pr = renderPr({ slug: "f", title: "T", summary: "S", features: { items: [{ name: "n", scenarios: [{ name: "s", passes: true, evidence: [`${FD}/evidence/e.txt`] }] }] }, featureDir: FD, branch: "relay/f", base: "main" });
    for (const h of ["Summary", "Traceability", "Verification", "Review", "Caveats", "gh pr create"]) assert.ok(pr.includes(h), h);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
