import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as W from "../lib/workspace.mjs";
import * as WI from "../lib/wsinit.mjs";
import * as I from "../lib/init.mjs";

const git = (d, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" });
function repo(root, name, files) {
  const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); git(d, "init", "-q", "-b", "main");
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  git(d, "add", "-A"); git(d, "commit", "-q", "-m", "init"); return d;
}
function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wsinit-"));
  repo(root, "api", { "package.json": JSON.stringify({ name: "items-api", scripts: { test: "node --test" }, dependencies: { express: "1" } }), "src/server.js": "server.listen(3000)" });
  repo(root, "web", { "package.json": JSON.stringify({ name: "items-web", scripts: { test: "node --test", dev: "vite" }, devDependencies: { vite: "5" } }), "index.html": "<html></html>", "src/client.js": "// contract: see ../api/src/server.js" });
  repo(root, "shared", { "package.json": JSON.stringify({ name: "shared-lib", scripts: { test: "node --test" } }) });
  return root;
}
const dets = (root, repos) => Object.fromEntries(repos.map((r) => [r.name, I.detect(r.path)]));

test("workspace config merge adds only missing keys and never overwrites", () => {
  const root = mk();
  try {
    const repos = W.listRepos(root, {});
    const d = dets(root, repos);
    const m = WI.mergeWorkspaceConfig(null, repos, d);
    assert.deepEqual(m.config.workspace, { repos: ["api", "shared", "web"], exclude: [] });
    assert.equal(m.config.checks.api.test, "npm test");
    assert.deepEqual(m.config.requiredChecks, ["test"]);
    const mine = { workspace: { repos: ["api"], exclude: ["x"] }, checks: { api: { test: "make t" } }, autonomy: "autonomous" };
    const m2 = WI.mergeWorkspaceConfig(mine, repos, d);
    assert.deepEqual(m2.config.workspace, mine.workspace);
    assert.deepEqual(m2.config.checks, mine.checks);
    assert.equal(m2.config.autonomy, "autonomous");
    assert.ok(!m2.added.includes("workspace") && !m2.added.includes("checks") && !m2.added.includes("autonomy"));
    const again = WI.mergeWorkspaceConfig(m.config, repos, d);
    assert.deepEqual(again.added, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("workspace AGENTS.md: roles, inferred relation with evidence, order, idempotent merge, user text kept", () => {
  const root = mk();
  try {
    const repos = W.listRepos(root, {});
    const d = dets(root, repos);
    assert.match(WI.roleOf(d.web), /client/);
    const rels = WI.relations(repos, d);
    const link = rels.find((x) => x.from === "web" && x.to === "api");
    assert.ok(link && link.kind === "inferred" && /\.\.\/api\//.test(link.evidence), JSON.stringify(rels));
    const body = WI.renderWorkspaceAgents(repos, d, rels);
    assert.match(body, /\| `api` \|/);
    assert.match(body, /not executed here/);
    const first = I.mergeAgentsMd("# Mine\nkeep me\n", body);
    assert.match(first.content, /keep me/);
    const second = I.mergeAgentsMd(first.content, body);
    assert.equal(second.changed, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("declared dependency links and dependency order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wsinit-"));
  try {
    repo(root, "lib", { "package.json": JSON.stringify({ name: "@x/lib" }) });
    repo(root, "app", { "package.json": JSON.stringify({ name: "app", dependencies: { "@x/lib": "^1" } }) });
    const repos = W.listRepos(root, {});
    const rels = WI.relations(repos, dets(root, repos));
    assert.deepEqual(rels.map((r) => [r.from, r.to, r.kind]), [["app", "lib", "declared"]]);
    assert.deepEqual(WI.dependencyOrder(["app", "lib"], rels), ["lib", "app"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("excluded repos are not listed or detected", () => {
  const root = mk();
  try {
    const repos = W.listRepos(root, { workspace: { exclude: ["shared"] } });
    assert.deepEqual(repos.map((r) => r.name), ["api", "web"]);
    const body = WI.renderWorkspaceAgents(repos, dets(root, repos), []);
    assert.ok(!body.includes("`shared`"));
    assert.equal(WI.repoInitStatus(repos[0]).agentsMd, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("dev port detected as {port, source} renders as a number", () => {
  const root = mk();
  try {
    const repos = W.listRepos(root, {});
    const d = dets(root, repos);
    d[repos[0].name] = { ...d[repos[0].name], apps: [{ devCommand: "npm run dev", port: { port: 5173, source: "script flag" } }] };
    const body = WI.renderWorkspaceAgents(repos, d, []);
    assert.ok(body.includes("(port 5173)") && !body.includes("[object Object]"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("source scan infers an HTTP service and its client link from shared routes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wsinit-"));
  repo(root, "svc", { "package.json": JSON.stringify({ name: "svc", scripts: { test: "node --test" } }), "src/server.js": 'import http from "node:http";\nexport const createServer = () => http.createServer((q, s) => { if (q.url.startsWith("/items")) s.end("[]"); });\n' });
  repo(root, "cli", { "package.json": JSON.stringify({ name: "cli", scripts: { test: "node --test" } }), "src/client.js": "export const list = (b) => fetch(`${b}/items`);\n" });
  try {
    const repos = W.listRepos(root, {});
    const d = dets(root, repos);
    assert.match(WI.roleOf(d.svc, path.join(root, "svc")), /service \/ API/);
    assert.match(WI.roleOf(d.cli, path.join(root, "cli")), /HTTP client/);
    const rels = WI.relations(repos, d);
    const l = rels.find((r) => r.from === "cli" && r.to === "svc");
    assert.ok(l && l.kind === "inferred" && /\/items/.test(l.evidence));
    assert.ok(!rels.some((r) => r.from === "svc" && r.to === "cli"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});