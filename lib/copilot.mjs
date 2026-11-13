// Host-neutral helpers for the GitHub Copilot port: agent translation, tier->model mapping,
// install planning and the preToolUse guard decision. Dependency-free ESM.
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";
import { checkRead, checkWrite, bashConfinementProblem } from "./policy.mjs";
import { holdoutAccessProblem } from "./holdout.mjs";

// pi tool -> Copilot tool alias (https://docs.github.com/en/copilot/reference/custom-agents-configuration)
const ALIAS = { read: "read", grep: "search", find: "search", ls: "search", bash: "execute", edit: "edit", write: "edit" };

export const COPILOT_ADDENDUM = `
## Running in GitHub Copilot (not pi)

This host has no \`relay_*\` / \`harness_state\` tools and no process-isolated workers. Read
\`.github/skills/relay/references/copilot-host.md\` (or \`~/.copilot/skills/relay/references/copilot-host.md\`) first and follow its
substitutions: delegate with the \`task\`/\`agent\` tool using the relay-* custom agents, edit state.json by hand, and run
checks/secret scans through shell commands. Guards are enforced only by the optional preToolUse hook; everything else is instruction-only.
`;

/** Resolve the Copilot model id for a tier: relay.config.json `copilotTiers`, else the pi mapping minus its provider prefix. */
export function copilotModel(config, tier) {
  const c = config || {};
  const m = c.copilotTiers?.[tier] ?? c.tiers?.[tier];
  if (!m) return null;
  return String(m).replace(/^[^/]+\//, "");
}

export function toCopilot(text, { config = null, orchestrator = false } = {}) {
  const { data, body } = parseFrontmatter(text);
  const tools = [...new Set((data.tools || "").split(",").map((t) => t.trim()).map((t) => ALIAS[t]).filter(Boolean))];
  if (orchestrator && !tools.includes("agent")) tools.push("agent");
  const model = (orchestrator && config?.copilotOrchestrator) || copilotModel(config, data.tier);
  const lines = ["---", `name: ${data.name}`, `description: ${JSON.stringify(data.description)}`, `tools: [${tools.map((t) => JSON.stringify(t)).join(", ")}]`];
  if (model) lines.push(`model: ${JSON.stringify(model)}`);
  lines.push("---", "");
  return lines.join("\n") + body.replace(/^\r?\n/, "") + (orchestrator ? COPILOT_ADDENDUM : "");
}

const listFiles = (dir, base = dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join("/")];
  });

/**
 * Plan an install. Returns [{ path, content } | { path, copyFrom }] with absolute paths under `dest`.
 * layout "repo"/"home": agents + skill + hook; layout "plugin": plugin.json + agents/ + skills/ + hooks.json.
 */
export function planInstall({ root, dest, layout = "repo", config = null, guard = true }) {
  const items = [];
  const agentsDir = layout === "plugin" ? "agents" : layout === "home" ? "agents" : ".github/agents";
  const skillsDir = layout === "plugin" ? "skills" : layout === "home" ? "skills" : ".github/skills";
  const hooksFile = layout === "plugin" ? "hooks.json" : layout === "home" ? "hooks/relay-guard.json" : ".github/hooks/relay-guard.json";
  const toolDir = layout === "plugin" ? "relay-runtime" : layout === "home" ? "relay" : ".github/relay";
  const at = (p) => path.join(dest, ...p.split("/"));

  for (const f of fs.readdirSync(path.join(root, "agents")).filter((f) => f.endsWith(".md"))) {
    const name = f.replace(/\.md$/, "");
    const content = toCopilot(fs.readFileSync(path.join(root, "agents", f), "utf8"), { config, orchestrator: name === "relay" });
    items.push({ path: at(`${agentsDir}/${name}.agent.md`), content });
  }
  const skillSrc = path.join(root, "skills", "relay");
  for (const rel of listFiles(skillSrc)) items.push({ path: at(`${skillsDir}/relay/${rel}`), copyFrom: path.join(skillSrc, rel) });

  if (guard) {
    // The guard needs lib/ (policy, holdout, copilot) at runtime; ship them next to the hook script.
    for (const rel of ["lib/policy.mjs", "lib/holdout.mjs", "lib/jsonschema.mjs", "lib/copilot.mjs", "lib/frontmatter.mjs", "scripts/copilot-guard.mjs"]) {
      items.push({ path: at(`${toolDir}/${rel}`), copyFrom: path.join(root, rel) });
    }
    const script = layout === "plugin" ? "${PLUGIN_ROOT}/relay-runtime/scripts/copilot-guard.mjs" : path.join(at(toolDir), "scripts", "copilot-guard.mjs");
    const cmd = `node "${script}"`;
    const hooks = { version: 1, hooks: { preToolUse: [{ type: "command", bash: cmd, powershell: cmd, timeoutSec: 10 }] } };
    items.push({ path: at(hooksFile), content: JSON.stringify(hooks, null, 2) + "\n" });
  }
  if (layout === "plugin") {
    const manifest = { name: "relay", description: "Relay: requirement-to-PR orchestrator and specialist agents", version: "0.1.0", agents: "agents/", skills: "skills/", ...(guard ? { hooks: "hooks.json" } : {}) };
    items.push({ path: at("plugin.json"), content: JSON.stringify(manifest, null, 2) + "\n" });
  }
  return items;
}

export function applyInstall(items, { dryRun = false } = {}) {
  for (const it of items) {
    if (!dryRun) {
      fs.mkdirSync(path.dirname(it.path), { recursive: true });
      if (it.copyFrom) fs.copyFileSync(it.copyFrom, it.path);
      else fs.writeFileSync(it.path, it.content);
    }
  }
  return items.map((i) => i.path);
}

const ROLE_RE = /^relay(-[a-z-]+)?$/;

/** Find the active feature dir (.ai/<slug>): RELAY_SLUG, else the most recently modified .ai/*\/state.json. */
export function activeFeatureDir(cwd, env = process.env) {
  if (env.RELAY_SLUG) return `.ai/${env.RELAY_SLUG}`;
  const ai = path.join(cwd, ".ai");
  if (!fs.existsSync(ai)) return null;
  let best = null;
  for (const d of fs.readdirSync(ai, { withFileTypes: true })) {
    const st = d.isDirectory() && path.join(ai, d.name, "state.json");
    if (st && fs.existsSync(st)) {
      const t = fs.statSync(st).mtimeMs;
      if (!best || t > best.t) best = { t, dir: `.ai/${d.name}` };
    }
  }
  return best?.dir ?? null;
}

/**
 * preToolUse decision for a Copilot hook payload (camelCase). Returns null to leave default behaviour,
 * or { permissionDecision: "deny", permissionDecisionReason }. Only relay-* subagents (agentType/agentName) are guarded;
 * the root agent is guarded as "relay" only when RELAY_ROLE=relay. Fails closed on a guarded role with unreadable input.
 */
export function guardDecision(payload, env = process.env) {
  const role = payload.agentType || payload.agentName || env.RELAY_ROLE || "";
  if (!ROLE_RE.test(role)) return null;
  const cwd = payload.cwd || process.cwd();
  const featureDir = activeFeatureDir(cwd, env);
  if (!featureDir) return null;
  const deny = (why) => ({ permissionDecision: "deny", permissionDecisionReason: `relay guard (${role}): ${why}` });
  let args = payload.toolArgs;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return deny("unparseable tool arguments"); }
  }
  args = args || {};
  const tool = String(payload.toolName || "").toLowerCase();
  const rel = (p) => path.relative(cwd, path.resolve(cwd, String(p || ""))).split(path.sep).join("/");
  const owned = env.RELAY_OWNED ? JSON.parse(env.RELAY_OWNED) : ["**"]; // slice ownership is not visible to hooks; **= unrestricted
  const isWrite = ["create", "edit", "write", "str_replace_editor", "apply_patch"].includes(tool);
  if (isWrite) {
    const target = rel(args.path || args.file_path || args.filePath);
    const r = role === "relay" && target === `${featureDir}/state.json` ? null : checkWrite({ role, rel: target, featureDir, owned });
    if (r) return deny(`cannot write ${target}: ${r}`);
  }
  if (["view", "read"].includes(tool)) {
    const r = checkRead({ role, rel: rel(args.path || args.file_path || args.filePath) });
    if (r) return deny(r);
  }
  if (["bash", "powershell", "grep", "rg", "glob"].includes(tool)) {
    const r = holdoutAccessProblem(role, JSON.stringify(args));
    if (r) return deny(r);
  }
  if (tool === "bash" || tool === "powershell") {
    const cmd = String(args.command || "");
    const esc = bashConfinementProblem(cmd, cwd);
    if (esc) return deny(`bash write confinement: ${esc}`);
    if (/\bgit\s+push\b/.test(cmd)) return deny("git push is not allowed");
    if (/\bgit\s+commit\b/.test(cmd) && role !== "relay-implementor") return deny(`${role} may not commit`);
  }
  return null;
}
