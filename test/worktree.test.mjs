import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureWorktree, findWorktree, excludeHarnessFiles, worktreePathFor, branchFor } from "../lib/worktree.mjs";
import { newState } from "../lib/state.mjs";
import { validate } from "../lib/jsonschema.mjs";

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
function mkRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-wt-")));
  const repo = path.join(dir, "app");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "a");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  return { dir, repo };
}

test("ensureWorktree creates a branch worktree beside the repo, then re-attaches", () => {
  const { dir, repo } = mkRepo();
  try {
    const wt = ensureWorktree(repo, "my-feat");
    assert.equal(wt.created, true);
    assert.equal(wt.branch, "relay/my-feat");
    assert.equal(wt.path, worktreePathFor(repo, "my-feat"));
    assert.ok(fs.existsSync(path.join(wt.path, "a.txt")));
    assert.equal(git(wt.path, "branch", "--show-current"), "relay/my-feat");
    assert.equal(findWorktree(repo, "my-feat").path, wt.path);
    const again = ensureWorktree(repo, "my-feat");
    assert.equal(again.created, false);
    assert.equal(again.path, wt.path);
    // findable from inside the worktree too
    assert.equal(findWorktree(wt.path, "my-feat").path, wt.path);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ensureWorktree re-adds a branch whose worktree dir was deleted", () => {
  const { dir, repo } = mkRepo();
  try {
    const wt = ensureWorktree(repo, "gone");
    fs.rmSync(wt.path, { recursive: true, force: true });
    assert.equal(findWorktree(repo, "gone"), undefined);
    const back = ensureWorktree(repo, "gone");
    assert.equal(back.created, true);
    assert.ok(fs.existsSync(back.path));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("excludeHarnessFiles keeps locks out of git status (idempotent)", () => {
  const { dir, repo } = mkRepo();
  try {
    const wt = ensureWorktree(repo, "lk");
    excludeHarnessFiles(wt.path);
    excludeHarnessFiles(wt.path);
    fs.mkdirSync(path.join(wt.path, ".ai", "lk"), { recursive: true });
    fs.writeFileSync(path.join(wt.path, ".ai", "lk", ".lock"), "{}");
    fs.writeFileSync(path.join(wt.path, ".ai", "lk", "spec.md"), "x");
    const st = git(wt.path, "status", "--porcelain", "-uall");
    assert.ok(!st.includes(".lock"));
    assert.ok(st.includes("spec.md"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("state records the worktree and validates", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../schemas/state.schema.json", import.meta.url), "utf8"));
  const st = newState({ slug: "x", requirement: "r", worktree: { path: "/tmp/w", branch: branchFor("x"), base: "HEAD" } });
  assert.deepEqual(validate(schema, st), []);
  assert.deepEqual(validate(schema, newState({ slug: "x", requirement: "r" })), []);
});
