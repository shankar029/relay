// Repo onboarding (`/relay-init`): preflight, detection, AGENTS.md merge, verifier-tool plan, baseline.
// Dependency-free ESM. Detection reads files only; nothing here installs or writes unless a function says so.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const INIT_SLUG = "repo-init";
export const AGENTS_START = "<!-- relay:init:start -->";
export const AGENTS_END = "<!-- relay:init:end -->";
export const TOOLS_DIR = ".relay/tools";
export const GITIGNORE_WANTED = [".ai/*/holdout/", ".ai/*/.lock", ".ai/*/verify-tools/", ".ai/*/_quarantine/", `.ai/${INIT_SLUG}/`, `${TOOLS_DIR}/node_modules/`, ".relay/tmp/", ".env", ".env.*"];

const exists = (cwd, ...p) => fs.existsSync(path.join(cwd, ...p));
const read = (cwd, ...p) => { try { return fs.readFileSync(path.join(cwd, ...p), "utf8"); } catch { return ""; } };
const json = (cwd, ...p) => { try { return JSON.parse(read(cwd, ...p)); } catch { return null; } };
const ls = (cwd, ...p) => { try { return fs.readdirSync(path.join(cwd, ...p)); } catch { return []; } };

export const defaultRun = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 30_000 });
  return { ok: r.status === 0, out: `${r.stdout || ""}`.trim(), err: `${r.stderr || ""}`.trim() };
};

export const defaultWhich = (cmd) => {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? `${r.stdout}`.split(/\r?\n/)[0].trim() : null;
};

// ---------- preflight ----------
export function preflight(cwd, run = defaultRun) {
  const g = (...a) => run("git", a, cwd);
  const out = { cwd, isRepo: false, commits: 0, branch: null, detached: false, defaultBranch: null, remotes: [], dirty: [], problems: [], warnings: [], offers: [] };
  if (!g("rev-parse", "--is-inside-work-tree").ok) {
    out.problems.push("not a git repository");
    out.offers.push("bootstrap_git");
    return out;
  }
  out.isRepo = true;
  const count = g("rev-list", "--count", "HEAD");
  out.commits = count.ok ? Number(count.out) || 0 : 0;
  if (!out.commits) { out.problems.push("repository has no commits (Relay branches worktrees from HEAD)"); out.offers.push("bootstrap_git"); }
  const br = g("symbolic-ref", "--short", "HEAD");
  if (br.ok) out.branch = br.out; else { out.detached = true; out.warnings.push("detached HEAD"); }
  const remoteHead = g("symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  out.defaultBranch = remoteHead.ok ? remoteHead.out.replace(/^origin\//, "") : out.branch;
  out.remotes = g("remote", "-v").out.split(/\r?\n/).filter(Boolean).map((l) => l.split(/\s+/).slice(0, 2).join(" ")).filter((v, i, a) => a.indexOf(v) === i);
  if (!out.remotes.length) out.warnings.push("no git remote (optional; Relay never pushes)");
  out.dirty = g("status", "--porcelain").out.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3)).filter((f) => !f.startsWith(".ai/") && !f.startsWith(".relay/"));
  if (out.dirty.length) out.warnings.push(`${out.dirty.length} uncommitted file(s); a feature worktree branches from HEAD, so these are not in it`);
  return out;
}

// ---------- detection ----------
const UI_DEPS = ["react", "react-dom", "vue", "svelte", "@angular/core", "next", "nuxt", "vite", "astro", "solid-js", "preact", "@sveltejs/kit", "remix", "@remix-run/react", "webpack-dev-server", "parcel", "gatsby"];
const API_DEPS = ["express", "fastify", "koa", "hono", "@nestjs/core", "restify", "hapi", "@hapi/hapi"];
const TEST_DEPS = { vitest: "vitest", jest: "jest", mocha: "mocha", ava: "ava", "@playwright/test": "playwright", cypress: "cypress", "@testing-library/react": "testing-library", tap: "tap", jasmine: "jasmine" };
const THIRD_PARTY = ["stripe", "twilio", "@sendgrid/mail", "aws-sdk", "@aws-sdk/client-s3", "openai", "@anthropic-ai/sdk", "firebase", "firebase-admin", "@slack/web-api", "nodemailer", "paypal-rest-sdk", "@octokit/rest", "mailgun.js", "plaid"];
const DEFAULT_PORT = { vite: 5173, next: 3000, nuxt: 3000, astro: 4321, "react-scripts": 3000, "@angular/cli": 4200, "@sveltejs/kit": 5173, gatsby: 8000, parcel: 1234 };

function pmOf(cwd) {
  if (exists(cwd, "pnpm-lock.yaml")) return "pnpm";
  if (exists(cwd, "yarn.lock")) return "yarn";
  if (exists(cwd, "bun.lockb") || exists(cwd, "bun.lock")) return "bun";
  if (exists(cwd, "package-lock.json") || exists(cwd, "package.json")) return "npm";
  return null;
}
const runScript = (pm, name) => (pm === "npm" ? (name === "test" || name === "start" ? `npm ${name}` : `npm run ${name}`) : `${pm} ${name === "test" ? "test" : `run ${name}`}`);

function workspaceDirs(cwd, pkg) {
  const globs = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages || [];
  const pnpm = read(cwd, "pnpm-workspace.yaml").split(/\r?\n/).map((l) => /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(l)?.[1]).filter(Boolean);
  const dirs = new Set();
  for (const g of [...globs, ...pnpm]) {
    const m = /^([^*]+)\/\*\*?$/.exec(g);
    if (m) for (const d of ls(cwd, m[1])) if (exists(cwd, m[1], d, "package.json")) dirs.add(`${m[1]}/${d}`);
    else if (!g.includes("*") && exists(cwd, g, "package.json")) dirs.add(g);
  }
  return [...dirs];
}

function portFrom(scriptText, depNames) {
  const m = /(?:--port[ =]|-p[ =]|PORT=)(\d{2,5})/.exec(scriptText || "");
  if (m) return { port: Number(m[1]), source: "script flag" };
  for (const d of depNames) if (DEFAULT_PORT[d]) return { port: DEFAULT_PORT[d], source: `${d} default (assumed, not run)` };
  return null;
}

function nodePackage(cwd, dir, pm, sink) {
  const pkg = json(cwd, dir, "package.json");
  if (!pkg) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const names = Object.keys(deps);
  const scripts = pkg.scripts || {};
  const at = dir === "." ? "" : `${dir}/`;
  const pre = dir === "." ? "" : `cd ${dir} && `;
  const src = `${at}package.json scripts`;
  const info = { dir, name: pkg.name || dir, private: !!pkg.private, scripts: Object.keys(scripts), kinds: [], port: null, devCommand: null };
  for (const n of ["build", "typecheck", "lint", "test", "dev", "start"]) {
    if (!scripts[n]) continue;
    const cmd = `${pre}${runScript(pm, n)}`;
    if (n === "dev" || n === "start") { if (!info.devCommand || n === "dev") info.devCommand = cmd; sink.commands[`${dir === "." ? "" : `${dir}:`}${n}`] = { cmd, source: src, scriptText: scripts[n] }; }
    else sink.commands[dir === "." ? n : `${dir}:${n}`] = { cmd, source: src, scriptText: scripts[n] };
  }
  if (!scripts.typecheck && (scripts["type-check"] || scripts.tsc)) sink.commands[dir === "." ? "typecheck" : `${dir}:typecheck`] = { cmd: `${pre}${runScript(pm, scripts["type-check"] ? "type-check" : "tsc")}`, source: src };
  if (!scripts.typecheck && !scripts["type-check"] && exists(cwd, dir, "tsconfig.json") && names.includes("typescript")) sink.commands[dir === "." ? "typecheck" : `${dir}:typecheck`] = { cmd: `${pre}npx tsc --noEmit`, source: `${at}tsconfig.json + typescript dependency (inferred)` };
  const ui = names.filter((n) => UI_DEPS.includes(n));
  const api = names.filter((n) => API_DEPS.includes(n));
  if (ui.length) info.kinds.push("browser-ui");
  if (api.length) info.kinds.push("api");
  if (pkg.bin) info.kinds.push("cli");
  if (!info.kinds.length) info.kinds.push("library");
  info.uiDeps = ui; info.apiDeps = api;
  info.port = portFrom(scripts.dev || scripts.start, [...ui, ...(/react-scripts/.test(scripts.start || "") ? ["react-scripts"] : [])]);
  for (const [d, label] of Object.entries(TEST_DEPS)) if (names.includes(d)) sink.testFrameworks.add(`${label}${dir === "." ? "" : ` (${dir})`}`);
  if (/node\s+--test/.test(scripts.test || "")) sink.testFrameworks.add("node:test");
  if (names.some((n) => THIRD_PARTY.includes(n))) sink.thirdParty.push(...names.filter((n) => THIRD_PARTY.includes(n)));
  if (pkg.engines?.node) sink.runtime.engines = pkg.engines.node;
  if (exists(cwd, dir, "index.html") || exists(cwd, dir, "public", "index.html")) info.hasHtmlEntry = true;
  return info;
}

export function detect(cwd, { which = defaultWhich, platform = process.platform, nodeVersion = process.version } = {}) {
  const sink = { commands: {}, testFrameworks: new Set(), thirdParty: [], runtime: { current: { node: nodeVersion }, pins: [] } };
  const pm = pmOf(cwd);
  const rootPkg = json(cwd, "package.json");
  const apps = [];
  const stacks = new Set();
  if (rootPkg) {
    stacks.add("node");
    for (const dir of [".", ...workspaceDirs(cwd, rootPkg)]) { const a = nodePackage(cwd, dir, pm, sink); if (a) apps.push(a); }
    if (exists(cwd, "tsconfig.json")) stacks.add("typescript");
  }
  const py = read(cwd, "pyproject.toml") + read(cwd, "requirements.txt") + read(cwd, "requirements-dev.txt");
  if (exists(cwd, "pyproject.toml") || exists(cwd, "requirements.txt") || exists(cwd, "setup.py")) {
    stacks.add("python");
    if (/pytest/i.test(py) || exists(cwd, "pytest.ini") || exists(cwd, "tests")) { sink.testFrameworks.add("pytest"); sink.commands.test ??= { cmd: "pytest", source: "pyproject/requirements mention pytest or tests/ exists (inferred)" }; }
    if (/ruff/.test(py)) sink.commands.lint ??= { cmd: "ruff check .", source: "ruff in python config" };
    if (/mypy/.test(py)) sink.commands.typecheck ??= { cmd: "mypy .", source: "mypy in python config" };
    if (/fastapi|flask|django|starlette/i.test(py)) apps.push({ dir: ".", name: "python-app", kinds: ["api"], scripts: [], port: null });
  }
  if (exists(cwd, "go.mod")) { stacks.add("go"); sink.commands.build ??= { cmd: "go build ./...", source: "go.mod" }; sink.commands.test ??= { cmd: "go test ./...", source: "go.mod" }; sink.commands.lint ??= { cmd: "go vet ./...", source: "go.mod" }; sink.testFrameworks.add("go test"); const gv = /^go\s+(\S+)/m.exec(read(cwd, "go.mod")); if (gv) sink.runtime.pins.push({ file: "go.mod", value: `go ${gv[1]}` }); }
  if (exists(cwd, "Cargo.toml")) { stacks.add("rust"); sink.commands.build ??= { cmd: "cargo build", source: "Cargo.toml" }; sink.commands.test ??= { cmd: "cargo test", source: "Cargo.toml" }; sink.commands.lint ??= { cmd: "cargo clippy -- -D warnings", source: "Cargo.toml" }; sink.testFrameworks.add("cargo test"); }
  if (exists(cwd, "pom.xml")) { stacks.add("java"); sink.commands.test ??= { cmd: "mvn -q test", source: "pom.xml" }; sink.commands.build ??= { cmd: "mvn -q -DskipTests package", source: "pom.xml" }; }
  if (exists(cwd, "build.gradle") || exists(cwd, "build.gradle.kts")) { stacks.add("java"); sink.commands.test ??= { cmd: process.platform === "win32" ? "gradlew.bat test" : "./gradlew test", source: "build.gradle" }; }
  if (ls(cwd).some((f) => /\.(sln|csproj)$/.test(f))) { stacks.add("dotnet"); sink.commands.build ??= { cmd: "dotnet build", source: "*.sln/*.csproj" }; sink.commands.test ??= { cmd: "dotnet test", source: "*.sln/*.csproj" }; }
  const make = read(cwd, "Makefile");
  if (make) for (const t of ["build", "test", "lint", "typecheck"]) if (new RegExp(`^${t}\\s*:`, "m").test(make)) sink.commands[t] ??= { cmd: `make ${t}`, source: "Makefile target" };

  for (const f of [".nvmrc", ".node-version", ".python-version", ".tool-versions", "rust-toolchain", "rust-toolchain.toml"]) if (exists(cwd, f)) sink.runtime.pins.push({ file: f, value: read(cwd, f).trim().split(/\r?\n/)[0] });
  if (sink.runtime.engines) sink.runtime.pins.push({ file: "package.json engines.node", value: sink.runtime.engines });
  const pinNode = sink.runtime.pins.find((p) => /nvmrc|node-version|engines/.test(p.file));
  const wantMajor = pinNode && /(\d+)/.exec(pinNode.value)?.[1];
  const haveMajor = /(\d+)/.exec(nodeVersion)?.[1];
  sink.runtime.mismatch = wantMajor && haveMajor && wantMajor !== haveMajor && !/[<>^~|]/.test(pinNode.value) ? `pinned node ${pinNode.value} but running ${nodeVersion}` : null;
  sink.runtime.unpinned = stacks.has("node") && !pinNode;

  const kinds = new Set(apps.flatMap((a) => a.kinds));
  const uiApps = apps.filter((a) => a.kinds.includes("browser-ui") || a.hasHtmlEntry);
  const ui = { browser: uiApps.length > 0, apps: uiApps.map((a) => ({ dir: a.dir, name: a.name, devCommand: a.devCommand, port: a.port, deps: a.uiDeps })) };
  const mobile = ["android", "ios", "pubspec.yaml", "src-tauri"].filter((f) => exists(cwd, f)).concat(Object.keys({ ...rootPkg?.dependencies, ...rootPkg?.devDependencies }).filter((d) => ["electron", "react-native", "expo", "@capacitor/core"].includes(d)));

  const composeFile = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].find((f) => exists(cwd, f));
  const services = composeFile ? (/^services:\s*\r?\n([\s\S]*?)(?:^\S|(?![\s\S]))/m.exec(read(cwd, composeFile))?.[1] || "").split(/\r?\n/).map((l) => /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(l)?.[1]).filter(Boolean) : [];
  const docker = { compose: composeFile || null, services, dockerfile: exists(cwd, "Dockerfile"), available: !!which("docker") };

  const ciFiles = [...ls(cwd, ".github", "workflows").filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`), ...[".gitlab-ci.yml", "azure-pipelines.yml", "Jenkinsfile", ".circleci/config.yml"].filter((f) => exists(cwd, f))];
  const ciCommands = [...new Set(ciFiles.flatMap((f) => [...read(cwd, f).matchAll(/^\s*(?:-\s*)?run:\s*(?:\|\s*)?(.+)$/gm)].map((m) => m[1].trim()).filter((c) => c && c !== "|" && !/^\$\{\{/.test(c))))].slice(0, 25);
  const ciMismatch = Object.entries(sink.commands).filter(([k, v]) => ["build", "test", "lint", "typecheck"].includes(k) && ciCommands.length && !ciCommands.some((c) => c.includes(v.cmd.replace(/^cd \S+ && /, "")))).map(([k, v]) => `${k}: local '${v.cmd}' not found verbatim in CI`);

  const hooks = { husky: exists(cwd, ".husky"), preCommit: exists(cwd, ".pre-commit-config.yaml"), lefthook: exists(cwd, "lefthook.yml"), gitHooks: ls(cwd, ".git", "hooks").filter((f) => !f.endsWith(".sample")) };
  const gi = read(cwd, ".gitignore").split(/\r?\n/).map((l) => l.trim());
  const missingIgnore = GITIGNORE_WANTED.filter((l) => !gi.includes(l) && !(l === ".env.*" && gi.includes(".env*")));
  const tools = { git: !!which("git"), node: !!which("node"), npm: !!which("npm"), gitleaks: !!which("gitleaks"), semgrep: !!which("semgrep"), docker: !!which("docker"), curl: !!which("curl") };
  const envFiles = ls(cwd).filter((f) => /^\.env(\.|$)/.test(f));
  const env = { files: envFiles, example: envFiles.filter((f) => /example|sample|template/.test(f)) };
  const sast = tools.semgrep ? "semgrep available (`semgrep --config auto`)" : "no SAST tool found; Relay's built-in heuristic secret scan still runs";
  const secrets = tools.gitleaks ? "gitleaks available" : "gitleaks not installed; Relay falls back to its heuristic secret scan (lib/secrets.mjs)";

  const checks = {};
  for (const n of ["build", "typecheck", "lint", "test"]) if (sink.commands[n]) checks[n] = sink.commands[n].cmd;
  return {
    stacks: [...stacks], packageManager: pm, apps, kinds: [...kinds], commands: sink.commands, checks, testFrameworks: [...sink.testFrameworks],
    ui, mobile, docker, ci: { files: ciFiles, commands: ciCommands, mismatch: ciMismatch }, runtime: { ...sink.runtime }, hooks, tools, env, secrets, sast,
    gitignore: { missing: missingIgnore }, thirdParty: [...new Set(sink.thirdParty)], platform,
    agentsMd: { exists: exists(cwd, "AGENTS.md"), hasRelayBlock: read(cwd, "AGENTS.md").includes(AGENTS_START) },
    relayConfig: { exists: exists(cwd, "relay.config.json") },
  };
}

// ---------- verifier tooling plan ----------
export const SHOT_SCRIPT = `// Relay verifier helper: node shot.mjs <url|data-url> <out.png> [--trace out.zip]
import { chromium } from "playwright";
const [url, out] = process.argv.slice(2);
if (!url || !out) { console.error("usage: node shot.mjs <url> <out.png>"); process.exit(2); }
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const res = await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.screenshot({ path: out, fullPage: true });
  console.log(JSON.stringify({ ok: true, url, status: res ? res.status() : null, title: await page.title(), screenshot: out }));
} finally { await browser.close(); }
`;

/** Highest non-prerelease version from `npm view <pkg> versions --json` output (the `latest` tag can point at an unpublishable alpha). */
export function latestStable(versionsJson) {
  let v; try { v = JSON.parse(versionsJson); } catch { return null; }
  if (typeof v === "string") v = [v];
  const ok = (Array.isArray(v) ? v : []).filter((x) => /^\d+\.\d+\.\d+$/.test(x));
  ok.sort((a, b) => { const A = a.split(".").map(Number), B = b.split(".").map(Number); return A[0] - B[0] || A[1] - B[1] || A[2] - B[2]; });
  return ok.length ? ok[ok.length - 1] : null;
}

export function verifierPlan(det) {
  const items = [];
  const notes = [];
  if (det.ui.browser) {
    items.push({
      id: "playwright", kind: "browser-ui", dir: TOOLS_DIR,
      summary: `Playwright + Chromium in ${TOOLS_DIR} (own package.json; the project's dependencies and lockfiles are not touched)`,
      commands: [`npm install --no-audit --no-fund playwright`, `npx playwright install chromium`],
      files: [`${TOOLS_DIR}/package.json`, `${TOOLS_DIR}/shot.mjs`],
      smoke: `node ${TOOLS_DIR}/shot.mjs <data-url> <evidence>/smoke.png`,
    });
    if (det.platform === "linux") notes.push("Linux: Chromium may need OS libraries; run `npx playwright install-deps chromium` (needs sudo). Relay never runs it for you.");
  }
  if (det.kinds.includes("api")) notes.push(det.tools.curl ? "API app: the verifier uses curl (found) or a small node script for real HTTP calls; nothing to install." : "API app: curl not found; the verifier will use node fetch scripts under verify-tools/.");
  if (det.kinds.includes("cli")) notes.push("CLI app: the verifier runs the binary through bash and saves output. Interactive TUIs need a pty runner (not installed by Relay; node-pty/pexpect compile native code).");
  if (det.mobile.length) notes.push(`Mobile/desktop shell detected (${det.mobile.join(", ")}): Relay cannot drive emulators or native windows; verify the web layer only and mark native scenarios blocked.`);
  if (!det.ui.browser && !det.kinds.includes("api") && !det.kinds.includes("cli")) notes.push("No UI/API/CLI surface detected: the verifier will use throwaway scripts that import the library.");
  return { items, notes };
}

// ---------- AGENTS.md merge and diff ----------
export function wrapBlock(body) {
  const clean = body.replace(new RegExp(`${AGENTS_START}|${AGENTS_END}`, "g"), "").trim();
  return `${AGENTS_START}\n${clean}\n${AGENTS_END}\n`;
}

/** Non-destructive: a fresh file becomes the block; an existing file keeps all content outside the managed block. */
export function mergeAgentsMd(existing, draft) {
  const block = wrapBlock(draft);
  if (!existing || !existing.trim()) return { content: block, mode: "create", changed: true };
  const s = existing.indexOf(AGENTS_START);
  const e = existing.indexOf(AGENTS_END);
  if (s >= 0 && e > s) {
    const content = existing.slice(0, s) + block.trimEnd() + existing.slice(e + AGENTS_END.length);
    return { content, mode: "replace-block", changed: content !== existing };
  }
  const content = `${existing.replace(/\s*$/, "")}\n\n${block}`;
  return { content, mode: "append-block", changed: true };
}

export function unifiedDiff(a, b, label = "AGENTS.md", context = 2) {
  const x = a.split(/\r?\n/), y = b.split(/\r?\n/);
  const n = x.length, m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { ops.push([" ", x[i]]); i++; j++; }
    else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) { ops.push(["+", y[j]]); j++; }
    else { ops.push(["-", x[i]]); i++; }
  }
  if (!ops.some((o) => o[0] !== " ")) return "";
  const keep = new Set();
  ops.forEach((o, k) => { if (o[0] !== " ") for (let d = -context; d <= context; d++) keep.add(k + d); });
  const out = [`--- a/${label}`, `+++ b/${label}`];
  let gap = false;
  ops.forEach((o, k) => { if (keep.has(k)) { out.push(`${o[0]}${o[1]}`); gap = false; } else if (!gap) { out.push("@@ ..."); gap = true; } });
  return out.join("\n");
}

// ---------- gitignore and config ----------
export function mergeGitignore(existing, wanted = GITIGNORE_WANTED) {
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const add = wanted.filter((l) => !have.has(l) && !(l === ".env.*" && have.has(".env*")));
  if (!add.length) return { content: existing, added: [] };
  const base = existing.replace(/\s*$/, "");
  return { content: `${base ? `${base}\n\n` : ""}# Relay\n${add.join("\n")}\n`, added: add };
}

/** Adds only missing keys; never overwrites a user's setting. */
export function mergeConfig(existing, det, verifier) {
  const cur = existing && typeof existing === "object" ? existing : {};
  const add = {};
  if (Object.keys(det.checks).length && !cur.checks) add.checks = det.checks;
  if (!cur.requiredChecks && det.checks.test) add.requiredChecks = ["test", ...(det.checks.lint ? ["lint"] : [])];
  if (!cur.autonomy) add.autonomy = "gated";
  if (!cur.budget) add.budget = { maxSubagentCalls: 60 };
  if (verifier && !cur.verifier) add.verifier = verifier;
  return { config: { ...cur, ...add }, added: Object.keys(add) };
}

// ---------- scout report gate ----------
const REQUIRED_HEADINGS = ["commands", "test", "layout"];

/** Problems with the scout's output; the harness retries the scout with these. Every verified command needs evidence on disk. */
export function scoutProblems({ report, draft, cwd }) {
  const p = [];
  if (!report || typeof report !== "object") return ["scout-report.json is missing or not an object"];
  if (!Array.isArray(report.commands) || !report.commands.length) p.push("scout-report.json: commands[] must list every command you ran or considered");
  for (const [i, c] of (report.commands || []).entries()) {
    if (!c || typeof c.command !== "string" || !["verified", "failed", "not-run"].includes(c.status)) { p.push(`commands[${i}]: needs command and status verified|failed|not-run`); continue; }
    if (c.status === "verified" && (c.exitCode !== 0 || !c.evidence || !cwd || !fs.existsSync(path.join(cwd, c.evidence)) || !fs.statSync(path.join(cwd, c.evidence)).size)) p.push(`commands[${i}] '${c.command}': verified needs exitCode 0 and a non-empty evidence file`);
    if (c.status === "not-run" && !c.reason) p.push(`commands[${i}] '${c.command}': not-run needs a reason`);
  }
  if (typeof draft === "string") {
    const low = draft.toLowerCase();
    for (const h of REQUIRED_HEADINGS) if (!low.includes(h)) p.push(`agents-draft.md should cover '${h}'`);
  }
  return p;
}

// ---------- baseline ----------
const DANGEROUS = /\b(publish|deploy|release|push|rm\s+-rf|drop\s|migrate:prod|terraform\s+apply)\b/i;

export function runBaseline(cwd, checks, { timeoutMs = 5 * 60_000, evidenceDir } = {}) {
  const results = {};
  for (const [name, cmd] of Object.entries(checks)) {
    if (DANGEROUS.test(cmd)) { results[name] = { cmd, status: "skipped", reason: "command looks destructive" }; continue; }
    const t0 = Date.now();
    const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", timeout: timeoutMs });
    const log = `# RESULT: ${r.status === 0 ? "PASS" : "FAIL"}\n$ ${cmd}\n${r.stdout || ""}\n${r.stderr || ""}`.slice(-20000);
    let evidence = null;
    if (evidenceDir) { fs.mkdirSync(evidenceDir, { recursive: true }); evidence = path.join(evidenceDir, `baseline-${name}.log`); fs.writeFileSync(evidence, log); }
    results[name] = { cmd, status: r.status === 0 ? "pass" : "fail", exitCode: r.status, ms: Date.now() - t0, evidence: evidence && path.relative(cwd, evidence).split(path.sep).join("/") };
  }
  return results;
}

// ---------- report ----------
export function renderReport({ preflight: pf, detection: d, applied = [], skipped = [], verifier, baseline, commit, notes = [] }) {
  const L = ["# Relay init report", ""];
  L.push("## Detected", `- Stacks: ${d.stacks.join(", ") || "none detected"}; package manager: ${d.packageManager || "n/a"}`);
  L.push(`- Apps: ${d.apps.map((a) => `${a.name} [${a.kinds.join("/")}]`).join("; ") || "none"}`);
  L.push(`- Test frameworks: ${d.testFrameworks.join(", ") || "none detected"}`);
  L.push(`- Checks: ${Object.entries(d.checks).map(([k, v]) => `${k}=\`${v}\``).join(", ") || "none detected"}`);
  L.push(`- Browser UI: ${d.ui.browser ? "yes" : "no"}; docker compose: ${d.docker.compose ? `${d.docker.compose} (${d.docker.services.join(", ") || "no services parsed"})` : "none"}; CI: ${d.ci.files.join(", ") || "none"}`);
  L.push(`- Runtime pins: ${d.runtime.pins.map((p) => `${p.file}=${p.value}`).join(", ") || "none"}${d.runtime.mismatch ? ` (WARNING: ${d.runtime.mismatch})` : ""}`);
  L.push(`- Secrets/SAST: ${d.secrets}; ${d.sast}`);
  if (pf) L.push(`- Git: branch ${pf.branch || "?"}, ${pf.commits} commit(s), remotes: ${pf.remotes.join(", ") || "none"}`);
  L.push("", "## Done", ...(applied.length ? applied.map((a) => `- ${a}`) : ["- nothing written"]));
  if (commit) L.push(`- committed ${commit}`);
  if (verifier) L.push(`- verifier tooling: ${verifier.status}${verifier.detail ? ` (${verifier.detail})` : ""}`);
  if (baseline) L.push("", "## Baseline checks", ...Object.entries(baseline).map(([k, v]) => `- ${k}: ${v.status}${v.exitCode != null && v.status === "fail" ? ` (exit ${v.exitCode})` : ""}${v.evidence ? ` [${v.evidence}]` : ""}`));
  L.push("", "## Skipped or needs you", ...(skipped.length ? skipped.map((s) => `- ${s}`) : ["- nothing"]), ...notes.map((n) => `- ${n}`));
  if (d.thirdParty.length) L.push(`- Third-party SDKs (${d.thirdParty.join(", ")}): specs touching them need a twin/mock design (skills/relay/references/digital-twins.md)`);
  if (d.ci.mismatch.length) L.push(...d.ci.mismatch.map((m) => `- CI mismatch: ${m}`));
  return `${L.join("\n")}\n`;
}
