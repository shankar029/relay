import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as I from "../lib/init.mjs";
import { checkWrite, requiredOutputs } from "../lib/policy.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "relay-init-"));
const put = (d, f, c) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
const git = (d, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" });
const which = () => null;

test("preflight: non-repo offers bootstrap; repo with commit is clean", () => {
  const d = tmp();
  const a = I.preflight(d);
  assert.equal(a.isRepo, false);
  assert.ok(a.offers.includes("bootstrap_git"));
  git(d, "init", "-q", "-b", "main");
  assert.ok(I.preflight(d).offers.includes("bootstrap_git"), "no commits yet");
  put(d, "a.txt", "x");
  git(d, "add", "-A"); git(d, "commit", "-q", "-m", "i");
  const b = I.preflight(d);
  assert.equal(b.isRepo, true);
  assert.equal(b.commits, 1);
  assert.ok(!b.offers.includes("bootstrap_git"));
});

test("detect: node web app with playwright-free browser UI and test script", () => {
  const d = tmp();
  put(d, "package.json", JSON.stringify({ name: "web", scripts: { dev: "vite --port 5173", build: "vite build", test: "vitest run", lint: "eslint ." }, devDependencies: { vite: "5", vitest: "1" } }));
  put(d, "index.html", "<html></html>");
  put(d, ".nvmrc", "20\n");
  const det = I.detect(d, { which, platform: "linux", nodeVersion: "v22.1.0" });
  assert.ok(det.stacks.includes("node"));
  assert.equal(det.ui.browser, true);
  assert.equal(det.checks.test, "npm test");
  assert.ok(det.runtime.pins.some((p) => p.value.includes("20")));
  assert.ok(det.runtime.mismatch, "pin 20 vs running 22");
  const plan = I.verifierPlan(det);
  assert.equal(plan.items[0].id, "playwright");
  assert.ok(plan.notes.some((n) => /install-deps/.test(n)));
});

test("detect: api-only repo needs no browser tooling", () => {
  const d = tmp();
  put(d, "package.json", JSON.stringify({ name: "api", scripts: { test: "node --test" }, dependencies: { express: "4" } }));
  put(d, "src/server.js", "app.listen(3000)");
  const det = I.detect(d, { which, platform: "win32" });
  assert.equal(det.ui.browser, false);
  assert.equal(I.verifierPlan(det).items.length, 0);
});

test("mergeAgentsMd: create, append, replace-block; user content is kept", () => {
  const c = I.mergeAgentsMd("", "# Draft");
  assert.equal(c.mode, "create");
  const a = I.mergeAgentsMd("# Mine\nkeep me\n", "# Draft");
  assert.equal(a.mode, "append-block");
  assert.ok(a.content.startsWith("# Mine\nkeep me"));
  const r = I.mergeAgentsMd(a.content, "# Draft v2");
  assert.equal(r.mode, "replace-block");
  assert.ok(r.content.includes("keep me") && r.content.includes("Draft v2") && !r.content.includes("# Draft\n"));
  assert.equal(I.mergeAgentsMd(r.content, "# Draft v2").changed, false, "idempotent");
});

test("unifiedDiff: empty when equal, shows +/- otherwise", () => {
  assert.equal(I.unifiedDiff("a\nb", "a\nb"), "");
  const d = I.unifiedDiff("a\nb\nc", "a\nx\nc");
  assert.match(d, /-b/);
  assert.match(d, /\+x/);
});

test("mergeGitignore is idempotent and never removes lines", () => {
  const a = I.mergeGitignore("dist/\n");
  assert.ok(a.content.startsWith("dist/"));
  assert.ok(a.added.includes(".ai/*/holdout/"));
  assert.deepEqual(I.mergeGitignore(a.content).added, []);
});

test("mergeConfig adds only missing keys and keeps user settings", () => {
  const det = { checks: { test: "npm test", lint: "npm run lint" } };
  const m = I.mergeConfig({ autonomy: "autonomous" }, det, { shot: "x" });
  assert.equal(m.config.autonomy, "autonomous");
  assert.deepEqual(m.config.checks, det.checks);
  assert.deepEqual(m.config.verifier, { shot: "x" });
  assert.deepEqual(I.mergeConfig(m.config, det, { shot: "x" }).added, []);
});

test("scoutProblems: verified needs exit 0 and non-empty evidence; not-run needs reason", () => {
  const d = tmp();
  put(d, "ev/a.log", "ok");
  put(d, "ev/empty.log", "");
  const draft = "## Layout\n## Commands\n## Testing";
  assert.deepEqual(I.scoutProblems({ report: { commands: [{ command: "npm test", status: "verified", exitCode: 0, evidence: "ev/a.log" }] }, draft, cwd: d }), []);
  assert.equal(I.scoutProblems({ report: { commands: [{ command: "npm test", status: "verified", exitCode: 0, evidence: "ev/empty.log" }] }, draft, cwd: d }).length, 1);
  assert.equal(I.scoutProblems({ report: { commands: [{ command: "npm test", status: "verified", exitCode: 1, evidence: "ev/a.log" }] }, draft, cwd: d }).length, 1);
  assert.equal(I.scoutProblems({ report: { commands: [{ command: "npm run deploy", status: "not-run" }] }, draft, cwd: d }).length, 1);
  assert.ok(I.scoutProblems({ report: null, draft, cwd: d }).length);
});

test("runBaseline runs checks, records evidence and skips destructive commands", () => {
  const d = tmp();
  const r = I.runBaseline(d, { test: `node -e "process.exit(0)"`, lint: `node -e "process.exit(3)"`, ship: "npm publish" }, { evidenceDir: path.join(d, "ev") });
  assert.equal(r.test.status, "pass");
  assert.equal(r.lint.status, "fail");
  assert.equal(r.lint.exitCode, 3);
  assert.equal(r.ship.status, "skipped");
  assert.ok(fs.existsSync(path.join(d, r.test.evidence)));
});

test("latestStable ignores prereleases", () => {
  assert.equal(I.latestStable(JSON.stringify(["1.9.0", "1.10.2", "1.66.0-alpha-2026-11-08", "1.10.10"])), "1.10.10");
  assert.equal(I.latestStable("not json"), null);
});

test("repo scout policy: writes only its draft, report and evidence", () => {
  const featureDir = ".ai/repo-init";
  const w = (rel) => checkWrite({ role: "relay-repo-scout", rel, featureDir });
  assert.equal(w(".ai/repo-init/agents-draft.md"), null);
  assert.equal(w(".ai/repo-init/scout-report.json"), null);
  assert.equal(w(".ai/repo-init/evidence/test.log"), null);
  assert.ok(w("src/index.js"));
  assert.ok(w("AGENTS.md"));
  assert.deepEqual(requiredOutputs("relay-repo-scout", featureDir), [".ai/repo-init/agents-draft.md", ".ai/repo-init/scout-report.json"]);
});
