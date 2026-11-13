import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { toCopilot } from "../scripts/gen-copilot-agents.mjs";
import { parseFrontmatter } from "../lib/frontmatter.mjs";

test("copilot generator maps tools and keeps body", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "agents", "relay-verifier.md"), "utf8");
  const out = toCopilot(src);
  assert.match(out, /^---\nname: relay-verifier\n/);
  assert.match(out, /tools: \["read", "search", "execute", "edit"\]/);
  assert.ok(!out.includes("relay_set_passes\""));
  assert.equal(parseFrontmatter(out).body.trim(), parseFrontmatter(src).body.trim());
});

import os from "node:os";
import { spawnSync } from "node:child_process";
import { copilotModel, planInstall, applyInstall, guardDecision } from "../lib/copilot.mjs";

const root = path.join(import.meta.dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "relay.config.json"), "utf8"));

test("tier->model mapping: orchestrator override, copilotTiers, pi fallback", () => {
  assert.equal(copilotModel({ tiers: { mid: "github-copilot/x-1" } }, "mid"), "x-1");
  assert.equal(copilotModel({ tiers: { mid: "a/x" }, copilotTiers: { mid: "y" } }, "mid"), "y");
  const items = planInstall({ root, dest: "/d", config });
  const get = (n) => items.find((i) => i.path.endsWith(`${n}.agent.md`)).content;
  assert.match(get("relay"), /model: "claude-sonnet-5.5"/);
  assert.match(get("relay"), /"agent"\]/);
  assert.match(get("relay-implementor"), /model: "gpt-6.1-sol"/);
  assert.ok(!/relay_subagent|tier:/.test(get("relay").split("---")[1]));
});

test("installer dry-run writes nothing; real run writes agents, skill, hook", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cp-"));
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "install-copilot.mjs"), "--dest", dest, "--dry-run"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /would write/);
  assert.deepEqual(fs.readdirSync(dest), []);
  applyInstall(planInstall({ root, dest, config }));
  for (const p of [".github/agents/relay.agent.md", ".github/skills/relay/SKILL.md", ".github/skills/relay/references/copilot-host.md", ".github/hooks/relay-guard.json", ".github/relay/lib/jsonschema.mjs"])
    assert.ok(fs.existsSync(path.join(dest, p)), p);
  // installed hook runs standalone
  const hook = path.join(dest, ".github", "relay", "scripts", "copilot-guard.mjs");
  const h = spawnSync(process.execPath, [hook], { input: JSON.stringify({ agentType: "relay-reviewer", cwd: dest, toolName: "view", toolArgs: { path: ".ai/x/holdout/scenarios.json" } }), encoding: "utf8", env: { ...process.env, RELAY_SLUG: "x" } });
  assert.match(h.stdout, /"permissionDecision":"deny"/);
  const plugin = planInstall({ root, dest: "/p", layout: "plugin", config });
  assert.ok(plugin.some((i) => i.path.endsWith("plugin.json") && /"agents": "agents\/"/.test(i.content)));
});

test("guard hook: role-based allow/deny", () => {
  const env = { RELAY_SLUG: "x" };
  const call = (agentType, toolName, toolArgs) => guardDecision({ agentType, cwd: root, toolName, toolArgs }, env);
  assert.equal(call("relay-implementor", "view", { path: "lib/policy.mjs" }), null);
  assert.equal(call("general-purpose", "view", { path: ".ai/x/holdout/a.json" }), null); // non-relay agents are not guarded
  assert.match(call("relay-implementor", "view", { path: ".ai/x/holdout/a.json" }).permissionDecisionReason, /holdout/);
  assert.equal(call("relay-verifier", "view", { path: ".ai/x/holdout/a.json" }), null);
  assert.ok(call("relay-implementor", "bash", { command: "cat .ai/x/ho''ldout/a.json" }));
  assert.ok(call("relay-implementor", "bash", { command: "echo x > ../outside.txt" }));
  assert.ok(call("relay-implementor", "bash", { command: "git push origin HEAD" }));
  assert.ok(call("relay-reviewer", "bash", { command: "git commit -am x" }));
  assert.ok(call("relay-implementor", "create", { path: ".git/config" }));
  assert.ok(call("relay-implementor", "create", { path: ".ai/x/state.json" }));
  assert.ok(guardDecision({ agentType: "relay-reviewer", cwd: root, toolName: "view", toolArgs: "{bad" }, env));
});
