import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prConfig, prTargets, cleanBody, linkBody, openPrs, planPrs } from "../lib/prs.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "relay-pr-"));
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

function mockRun({ remote = true, existing = {}, pushFail = false, ghMissing = false } = {}) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    if (cmd === "gh" && args[0] === "--version") return ghMissing ? { code: 1, stdout: "", stderr: "x" } : ok("gh 2");
    if (cmd === "git" && args[0] === "remote") return remote ? ok("git@x:o/r.git\n") : { code: 2, stdout: "", stderr: "no remote" };
    if (cmd === "git" && args[0] === "push") return pushFail ? { code: 1, stdout: "", stderr: "rejected" } : ok();
    if (cmd === "git") return ok("abc123\n");
    if (cmd === "gh" && args[1] === "list") return ok(JSON.stringify(existing[path.basename(opts.cwd)] ? [{ url: existing[path.basename(opts.cwd)] }] : []));
    if (cmd === "gh" && args[1] === "view") return ok("main\n");
    if (cmd === "gh" && args[1] === "create") return ok(`https://github.com/o/${path.basename(opts.cwd)}/pull/${calls.length}\n`);
    return ok();
  };
  return { run, calls };
}

function fixture(names = ["api", "web"]) {
  const dir = tmp();
  const targets = names.map((n) => {
    fs.writeFileSync(path.join(dir, `pr-${n}.md`), `# T (${n})\n\n## Related PRs (fill in after opening)\n${names.filter((x) => x !== n).map((x) => `- ${x}: <PR URL> (branch \`relay/f\`)`).join("\n")}\n\n## Create the PR (not run by Relay)\n\`\`\`sh\ngit push\n\`\`\`\n`);
    return { name: n, dir: path.join(dir, n), branch: "relay/f", base: "HEAD", bodyFile: path.join(dir, `pr-${n}.md`) };
  });
  return { dir, targets };
}

test("prConfig: auto defaults on, can be disabled", () => {
  assert.equal(prConfig({}).auto, true);
  assert.equal(prConfig({ pr: { auto: false } }).auto, false);
});

test("prTargets: workspace repos without commits are skipped; single repo uses the worktree", () => {
  const st = { workspace: { repos: { api: { path: "/c/api", branch: "relay/f" }, web: { path: "/c/web", branch: "relay/f" } } } };
  const t = prTargets(st, "/c/.ai/f", [{ name: "api", commits: ["x"] }, { name: "web", commits: [] }]);
  assert.deepEqual(t.map((x) => x.name), ["api"]);
  const s = prTargets({ worktree: { path: "/w", branch: "relay/f" } }, "/w/.ai/f");
  assert.equal(s[0].bodyFile.replace(/\\/g, "/"), "/w/.ai/f/pr.md");
});

test("cleanBody drops the manual how-to; linkBody fills sibling URLs", () => {
  const md = "# T\n\n## Related PRs (fill in after opening)\n- web: <PR URL> (branch `b`)\n\n## Create the PR (not run by Relay)\nstuff\n";
  assert.ok(!cleanBody(md).includes("Create the PR"));
  assert.match(linkBody(cleanBody(md), { web: "https://x/1" }), /- web: https:\/\/x\/1/);
});

test("openPrs: pushes only relay/<slug> with no force, creates one PR per repo and cross-links", () => {
  const { targets } = fixture();
  const { run, calls } = mockRun();
  const res = openPrs({ targets, slug: "f", title: "T", run });
  assert.deepEqual(res.map((r) => r.status), ["created", "created"]);
  const pushes = calls.filter((c) => c.cmd === "git" && c.args[0] === "push");
  assert.equal(pushes.length, 2);
  for (const p of pushes) { assert.deepEqual(p.args, ["push", "-u", "origin", "relay/f:relay/f"]); assert.ok(!p.args.some((a) => /force|-f$/.test(a))); }
  const edits = calls.filter((c) => c.cmd === "gh" && c.args[1] === "edit");
  assert.equal(edits.length, 2);
  assert.equal(calls.filter((c) => c.cmd === "gh" && c.args[1] === "create").length, 2);
});

test("openPrs: idempotent: recorded or already-open PRs are reused, nothing pushed", () => {
  const { targets } = fixture();
  const a = mockRun({ existing: { api: "https://x/api/pull/9" } });
  const res = openPrs({ targets, slug: "f", title: "T", run: a.run, existing: { web: { url: "https://x/web/pull/3" } } });
  assert.deepEqual(res.map((r) => [r.status, r.url]), [["exists", "https://x/api/pull/9"], ["exists", "https://x/web/pull/3"]]);
  assert.equal(a.calls.filter((c) => c.args[0] === "push" || c.args[1] === "create").length, 0);
});

test("openPrs: refuses non relay/<slug> branches (never main)", () => {
  const { targets } = fixture(["api"]);
  targets[0].branch = "main";
  const { run, calls } = mockRun();
  const res = openPrs({ targets, slug: "f", title: "T", run });
  assert.equal(res[0].status, "failed");
  assert.equal(calls.filter((c) => c.args[0] === "push").length, 0);
});

test("openPrs: reports missing gh, missing remote and push failure without throwing", () => {
  const { targets } = fixture(["api"]);
  assert.match(openPrs({ targets, slug: "f", title: "T", run: mockRun({ ghMissing: true }).run })[0].error, /gh CLI/);
  assert.match(openPrs({ targets, slug: "f", title: "T", run: mockRun({ remote: false }).run })[0].error, /origin/);
  const r = openPrs({ targets, slug: "f", title: "T", run: mockRun({ pushFail: true }).run });
  assert.match(r[0].error, /push failed/);
});

test("planPrs flags missing remote and wrong branch", () => {
  const { targets } = fixture(["api"]);
  const p = planPrs({ targets, slug: "other", run: mockRun({ remote: false }).run });
  assert.equal(p[0].problems.length, 2);
});
