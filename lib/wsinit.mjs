// Workspace-level /relay-init helpers: config merge and a deterministic workspace AGENTS.md.
// Everything here is derived from files (detection), never executed; per-repo AGENTS.md hold the verified commands.
import fs from "node:fs";
import path from "node:path";
import * as I from "./init.mjs";

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const SRC_RE = /\.(m?[jt]sx?|py|go|rs|java|cs|html|vue|svelte)$/;
const SKIP = new Set(["node_modules", ".git", ".ai", ".relay", "dist", "build", "target", "vendor", ".venv"]);

function* sourceFiles(dir, depth = 0, budget = { n: 300 }) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (budget.n <= 0) return;
    if (e.isDirectory()) { if (!SKIP.has(e.name) && depth < 4) yield* sourceFiles(path.join(dir, e.name), depth + 1, budget); }
    else if (SRC_RE.test(e.name)) { budget.n--; yield path.join(dir, e.name); }
  }
}

const SERVER_RE = /\b(?:createServer\s*\(|express\s*\(|fastify\s*\(|new\s+Koa\b|Flask\s*\(|FastAPI\s*\(|http\.ListenAndServe|app\.listen\s*\()/;
const CLIENT_RE = /\b(?:fetch\s*\(|axios[.(]|XMLHttpRequest|requests\.(?:get|post)|http\.Get\s*\()/;
const ROUTE_RE = /(?<=["'`}])(\/[A-Za-z][\w-]*)(?=[/"'`?:$])/g;

/** Light source scan: does the repo serve HTTP routes, or call HTTP endpoints? Cached per path in `cache`. */
export function scanRepo(repoPath, cache = new Map()) {
  if (cache.has(repoPath)) return cache.get(repoPath);
  const out = { server: null, client: null, routes: new Set(), calls: new Map() };
  for (const f of sourceFiles(repoPath)) {
    if (/(^|[\\/])(test|tests|__tests__)[\\/]|\.(test|spec)\./.test(path.relative(repoPath, f))) continue;
    let t = ""; try { t = fs.readFileSync(f, "utf8").slice(0, 200_000); } catch { continue; }
    const rel = path.relative(repoPath, f).replace(/\\/g, "/");
    if (SERVER_RE.test(t)) { out.server = out.server || rel; for (const m of t.matchAll(ROUTE_RE)) out.routes.add(m[1]); }
    if (CLIENT_RE.test(t)) { out.client = out.client || rel; for (const m of t.matchAll(ROUTE_RE)) if (!out.calls.has(m[1])) out.calls.set(m[1], rel); }
  }
  cache.set(repoPath, out);
  return out;
}

export function roleOf(det, repoPath) {
  const kinds = new Set(det.kinds || []);
  if (det.ui?.browser || kinds.has("browser-ui")) return "client (browser UI)";
  if (kinds.has("api")) return "service / API";
  if (kinds.has("cli")) return "CLI";
  if (repoPath) {
    const s = scanRepo(repoPath);
    if (s.server) return "service / API (inferred from source)";
    if (s.client) return "HTTP client library (inferred from source)";
  }
  if (kinds.has("library")) return "library";
  return det.stacks?.length ? "unclassified" : "no recognised stack";
}

/**
 * Inter-repo relations. `declared` come from manifests (package deps, file: links); `inferred` from sibling ports or repo names
 * appearing in source. Each carries its evidence so the user can judge it.
 */
export function relations(repos, dets) {
  const pk = Object.fromEntries(repos.map((r) => [r.name, readJson(path.join(r.path, "package.json"))]));
  const byPkg = Object.fromEntries(repos.filter((r) => pk[r.name]?.name).map((r) => [pk[r.name].name, r.name]));
  const out = [];
  const add = (from, to, kind, evidence) => { if (from !== to && !out.some((o) => o.from === from && o.to === to && o.kind === kind)) out.push({ from, to, kind, evidence }); };
  for (const r of repos) {
    const deps = { ...pk[r.name]?.dependencies, ...pk[r.name]?.devDependencies };
    for (const [dn, dv] of Object.entries(deps)) {
      if (byPkg[dn]) add(r.name, byPkg[dn], "declared", `package.json dependency "${dn}"`);
      else { const m = /^(?:file|link):\.\.\/([^/]+)/.exec(String(dv)); if (m && repos.some((x) => x.name === m[1])) add(r.name, m[1], "declared", `package.json ${dn}: ${dv}`); }
    }
    const ports = repos.filter((o) => o.name !== r.name).flatMap((o) => (dets[o.name]?.apps || []).filter((a) => a.port).map((a) => ({ repo: o.name, port: a.port })));
    const names = repos.filter((o) => o.name !== r.name).map((o) => o.name);
    const seen = new Set();
    for (const f of sourceFiles(r.path)) {
      let t = ""; try { t = fs.readFileSync(f, "utf8").slice(0, 200_000); } catch { continue; }
      for (const p of ports) if (!seen.has(`p${p.repo}`) && new RegExp(`(?:localhost|127\\.0\\.0\\.1):${p.port}\\b`).test(t)) { seen.add(`p${p.repo}`); add(r.name, p.repo, "inferred", `${path.relative(r.path, f).replace(/\\/g, "/")} references port ${p.port}`); }
      for (const o of repos) {
        if (o.name === r.name || seen.has(`r${o.name}`)) continue;
        const sc = scanRepo(o.path);
        const hit = sc.server && [...sc.routes].find((rt) => scanRepo(r.path).calls.has(rt));
        if (hit) { seen.add(`r${o.name}`); add(r.name, o.name, "inferred", `${scanRepo(r.path).calls.get(hit)} makes HTTP calls to route ${hit}, served by ${o.name} (${sc.server}); base URL is a runtime parameter`); }
      }
      for (const n of names) if (!seen.has(`n${n}`) && new RegExp(`\\.\\./${n}/`).test(t)) { seen.add(`n${n}`); add(r.name, n, "inferred", `${path.relative(r.path, f).replace(/\\/g, "/")} references ../${n}/`); }
    }
  }
  return out;
}

/** Adds only missing keys: never overwrites or reorders anything the user set. `workspace` is only added when absent entirely. */
export function mergeWorkspaceConfig(existing, repos, dets) {
  const cur = existing && typeof existing === "object" ? existing : {};
  const add = {};
  const names = repos.map((r) => r.name);
  if (!cur.workspace) add.workspace = { repos: names, exclude: [] };
  if (!cur.checks) {
    const per = Object.fromEntries(names.map((n) => [n, dets[n]?.checks || {}]).filter(([, c]) => Object.keys(c).length));
    if (Object.keys(per).length) add.checks = per;
  }
  if (!cur.requiredChecks && names.some((n) => dets[n]?.checks?.test)) add.requiredChecks = ["test"];
  if (!cur.autonomy) add.autonomy = "gated";
  if (!cur.budget) add.budget = { maxSubagentCalls: 60 };
  return { config: { ...cur, ...add }, added: Object.keys(add) };
}

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|") || "-";

/** Deterministic workspace AGENTS.md body (wrapped by mergeAgentsMd). */
export function renderWorkspaceAgents(repos, dets, rels, { repoAgents = {} } = {}) {
  const L = [];
  L.push("# Workspace", "", "This folder is not a git repo; it groups the repos below. Relay (`/skill:relay`) runs here in workspace mode: each feature gets a local container `.relay-features/<slug>/` and one worktree per touched repo on `relay/<slug>`. See the Relay repo's `docs/multi-repo.md`.", "");
  L.push("## Repos", "", "| Repo | Role | Stacks | Branch | Test command | Own AGENTS.md |", "|---|---|---|---|---|---|");
  for (const r of repos) {
    const d = dets[r.name] || {};
    L.push(`| \`${r.name}\` | ${cell(roleOf(d, r.path))} | ${cell((d.stacks || []).join(", "))} | ${cell(r.branch)} | ${cell(d.checks?.test ? `\`${d.checks.test}\`` : "")} | ${repoAgents[r.name] ? "yes" : "not yet (run /relay-init)"} |`);
  }
  L.push("", "## How the repos relate", "");
  if (!rels.length) L.push("No inter-repo links were found in manifests or source. Add the contracts (endpoints, shared types, ordering) here by hand, outside the managed block.");
  for (const x of rels) L.push(`- \`${x.from}\` -> \`${x.to}\` (${x.kind}: ${x.evidence})`);
  if (rels.some((x) => x.kind === "inferred")) L.push("", "_\"inferred\" links come from ports/paths found in source; confirm them._");
  L.push("", "## Build, test and run commands", "", "Run commands inside the repo that owns them. These are detected from files and **not executed here**; each repo's own AGENTS.md holds the verified commands.", "");
  for (const r of repos) {
    const d = dets[r.name] || {};
    const cmds = Object.entries(d.checks || {});
    L.push(`- \`${r.name}\`: ${cmds.length ? cmds.map(([k, v]) => `${k}: \`${v}\``).join(", ") : "no commands detected"}${(d.apps || []).some((a) => a.devCommand) ? `; dev: ${(d.apps || []).filter((a) => a.devCommand).map((a) => `\`${a.devCommand}\`${a.port ? ` (port ${a.port})` : ""}`).join(", ")}` : ""}`);
  }
  const order = dependencyOrder(repos.map((r) => r.name), rels);
  L.push("", "## Cross-repo conventions", "", `- Suggested change order (dependencies first): ${order.map((n) => `\`${n}\``).join(" -> ")}.`, "- A Relay slice owns exactly one repo; cross-repo contracts and ordering belong in the feature design.", "- Relay pushes and opens PRs only via `relay_pr` after you confirm; it writes one `pr-<repo>.md` per touched repo plus a feature `pr.md`.", "- Required checks are per repo (`<repo>:test` etc., from `relay.config.json` `checks`).");
  return L.join("\n");
}

/** Providers before consumers (topological; cycles and ties keep input order). */
export function dependencyOrder(names, rels) {
  const deps = Object.fromEntries(names.map((n) => [n, new Set(rels.filter((x) => x.from === n).map((x) => x.to))]));
  const out = [];
  const left = [...names];
  while (left.length) {
    const i = left.findIndex((n) => [...deps[n]].every((d) => out.includes(d) || !left.includes(d)));
    out.push(...left.splice(i < 0 ? 0 : i, 1));
  }
  return out;
}

/** Per-repo init status so the orchestrator knows what is left. */
export function repoInitStatus(repo) {
  const has = (f) => fs.existsSync(path.join(repo.path, f));
  const agents = has("AGENTS.md") && fs.readFileSync(path.join(repo.path, "AGENTS.md"), "utf8").includes(I.AGENTS_START);
  return { name: repo.name, path: repo.path, hasCommit: repo.hasCommit, dirty: repo.dirty, agentsMd: agents, config: has("relay.config.json"), verifier: has(path.join(I.TOOLS_DIR, "shot.mjs")), initState: has(path.join(".ai", I.INIT_SLUG, "init.json")) };
}
