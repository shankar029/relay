#!/usr/bin/env node
// Drives a real pi session (RPC mode) through the Relay skill and auto-answers
// extension UI dialogs (relay_approval uses ctx.ui.confirm). SIMULATED approvals are
// logged as such. Usage: node scripts/live-run.mjs <target-repo> <model> "<requirement>" [--log file]
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [repo, model, requirement] = process.argv.slice(2);
const logFile = process.argv.includes("--log") ? process.argv[process.argv.indexOf("--log") + 1] : "live-run.log";
if (!repo || !model || !requirement) { console.error("usage: live-run.mjs <repo> <model> <requirement> [--log file]"); process.exit(2); }

const npmRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
const cli = path.join(npmRoot, "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const log = fs.createWriteStream(logFile);
const proc = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "-e", path.join(home, "extensions/harness/index.ts"),
  "--skill", path.join(home, "skills/relay"), "--model", model], { cwd: repo, stdio: ["pipe", "pipe", "inherit"], env: process.env });

const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
let done;
let finished = new Promise((r) => (done = r));
const maxNudges = process.argv.includes("--nudges") ? Number(process.argv[process.argv.indexOf("--nudges") + 1]) : 0;
readline.createInterface({ input: proc.stdout }).on("line", (l) => {
  log.write(l + "\n");
  let e; try { e = JSON.parse(l); } catch { return; }
  if (e.type === "extension_ui_request") {
    if (e.method === "confirm") {
      console.log(`[SIMULATED APPROVAL] ${e.title}: ${String(e.message).slice(0, 120)}`);
      send({ type: "extension_ui_response", id: e.id, confirmed: true });
    } else if (["select", "input", "editor"].includes(e.method)) {
      console.log(`[UI ${e.method}] cancelled: ${e.title}`);
      send({ type: "extension_ui_response", id: e.id, cancelled: true });
    }
  } else if (e.type === "tool_execution_start") console.log(`tool: ${e.toolName} ${JSON.stringify(e.args).slice(0, 140)}`);
  else if (e.type === "agent_end") done();
});
proc.on("exit", () => done());

send({ type: "prompt", message: `/skill:relay ${requirement}` });
// Generic nudge when the orchestrator stops before the pr phase (logged; counts as hand-holding).
for (let n = 0; ; n++) {
  await finished;
  const wtRoot = path.join(path.dirname(repo), path.basename(repo) + ".relay-worktrees");
  const stateFiles = (fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot, { withFileTypes: true }) : []).filter((d) => d.isDirectory() && (!process.env.RELAY_SLUG || d.name === process.env.RELAY_SLUG))
    .map((d) => path.join(wtRoot, d.name, ".ai", d.name, "state.json")).filter(fs.existsSync);
  const phases = stateFiles.map((f) => JSON.parse(fs.readFileSync(f, "utf8")).phase);
  console.log(`[agent ended] phases=${phases.join(",")} nudges=${n}`);
  if (n >= maxNudges || phases.some((p) => p === "pr" || p === "done")) break;
  console.log("[NUDGE] sending generic continue message");
  finished = new Promise((r) => (done = r));
  send({ type: "prompt", message: "Continue the Relay workflow autonomously from the current phase until the pr phase is complete. Do not ask me questions; I approve all approvals." });
}
proc.stdin.end();
setTimeout(() => proc.kill(), 2000);
