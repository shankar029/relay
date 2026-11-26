import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validate } from "./jsonschema.mjs";
import { docLaneProblem } from "./docreview.mjs";

/** Shared fan-out/merge mechanism for read-only lanes: researcher topics and reviewer lenses. */
export const LANE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const DEFAULT_LENSES = ["correctness", "security", "tests", "performance"];
export const CITATION_RE = /^[^\s:][^\s]*:\d+(-\d+)?$/;
const BLOCKING = new Set(["blocker", "major"]);
const RANK = { blocker: 3, major: 2, minor: 1 };

export const LENS_CHECKLISTS = {
  correctness: "logic errors, edge cases, error handling, spec conformance (anything unimplemented or extra), contract adherence, code quality and maintainability",
  security: "injection, authn/authz, secrets, unsafe deserialisation or file/path handling, dependency risk, input validation, data exposure",
  tests: "meaningful assertions, coverage of new behaviour and error paths, weakened/deleted tests, flaky patterns, test isolation",
  performance: "algorithmic complexity, N+1 queries, unbounded memory/IO, blocking calls on hot paths, missing pagination or caching where the spec needs it",
  accessibility: "semantic markup, keyboard navigation, focus management, labels/ARIA, contrast, screen-reader behaviour (UI diffs only)",
  "api-contract": "endpoint paths/verbs, status codes, request/response shapes, backwards compatibility, error format, documentation of changed endpoints",
};

export const researchPath = (fd, lane) => (lane ? `${fd}/research-${lane}.md` : `${fd}/research.md`);
export const reviewPath = (fd, lane) => (lane ? `${fd}/reports/review-${lane}.json` : `${fd}/reports/review.md`);

/** Returns an error string for an invalid or duplicated lane set in one parallel call, else null. */
export function laneProblem(tasks) {
  for (const agent of ["relay-researcher", "relay-reviewer"]) {
    const ts = tasks.filter((t) => t.agent === agent);
    if (ts.length > 1 && ts.some((t) => !t.lane)) return `${agent}: every task needs a lane when fanning out`;
    const lanes = ts.map((t) => t.lane).filter(Boolean);
    if (new Set(lanes).size !== lanes.length) return `${agent}: duplicate lanes`;
    for (const l of lanes) if (!LANE_RE.test(l) || l === "consolidated") return `${agent}: invalid lane "${l}" (kebab-case, not "consolidated")`;
  }
  for (const t of tasks) if (t.lane && !["relay-researcher", "relay-reviewer", "relay-doc-reviewer"].includes(t.agent)) return `lane is only for relay-researcher / relay-reviewer / relay-doc-reviewer`;
  const dl = docLaneProblem(tasks);
  if (dl) return dl;
  if (tasks.some((t) => t.agent === "relay-doc-reviewer" && !t.lane)) return "relay-doc-reviewer: lane is required (<doc>-<lens>)";
  return null;
}

/** Lens set: relay.config.json `reviewLenses` (default four), plus accessibility for UI diffs and api-contract for endpoint changes. */
export function reviewLenses(config, changedFiles = []) {
  const base = Array.isArray(config?.reviewLenses) && config.reviewLenses.length ? config.reviewLenses.filter((l) => LANE_RE.test(l)) : DEFAULT_LENSES;
  const out = [...base];
  const files = changedFiles.filter((f) => !f.startsWith(".ai/"));
  if (!out.includes("accessibility") && files.some((f) => /\.(tsx|jsx|vue|svelte|html?|css|scss)$/i.test(f))) out.push("accessibility");
  if (!out.includes("api-contract") && files.some((f) => /(^|\/)(routes?|controllers?|api|endpoints?|openapi[^/]*|swagger[^/]*)(\/|\.|$)/i.test(f))) out.push("api-contract");
  return out;
}

const listLane = (dir, re) => { try { return fs.readdirSync(dir).filter((n) => re.test(n)).sort(); } catch { return []; } };
const hasCitation = (s) => /[\w./\\-]+\.\w+:\d+/.test(s);

/** Deterministic merge of research-<topic>.md into research.md; `conflicts` (orchestrator text) is mandatory when >1 topic. */
export function mergeResearch(cwd, fd, conflicts = "") {
  const dir = path.join(cwd, fd);
  const files = listLane(dir, /^research-[a-z0-9-]+\.md$/);
  if (!files.length) return { ok: false, error: "no research-<topic>.md files to merge" };
  if (files.length > 1 && !conflicts.trim()) return { ok: false, error: "conflicts/gaps text required: list conflicts between topics and gaps (write 'none found' only if you checked)" };
  const parts = [], bad = [];
  for (const n of files) {
    const body = fs.readFileSync(path.join(dir, n), "utf8").trim();
    const topic = n.replace(/^research-|\.md$/g, "");
    if (!body) bad.push(`${n} is empty`);
    else if (!hasCitation(body)) bad.push(`${n} has no file:line citations`);
    parts.push(`## Topic: ${topic}\n\n${body.replace(/^#\s.*\n+/, "")}`);
  }
  if (bad.length) return { ok: false, error: bad.join("; ") };
  const md = `# Research (merged from ${files.length} topic${files.length > 1 ? "s" : ""})\n\n${parts.join("\n\n")}\n\n## Conflicts and gaps (orchestrator)\n\n${conflicts.trim() || "Single topic; see its Gaps section."}\n`;
  fs.writeFileSync(path.join(dir, "research.md"), md);
  return { ok: true, topics: files.map((n) => n.replace(/^research-|\.md$/g, "")) };
}

/** Research gate: fan-out topic files must be cited and merged into research.md. */
export function researchProblems(cwd, fd) {
  const dir = path.join(cwd, fd);
  const files = listLane(dir, /^research-[a-z0-9-]+\.md$/);
  if (!files.length) return [];
  const out = [];
  let merged = "";
  try { merged = fs.readFileSync(path.join(dir, "research.md"), "utf8"); } catch { /* reported by caller */ }
  for (const n of files) {
    const topic = n.replace(/^research-|\.md$/g, "");
    if (!hasCitation(fs.readFileSync(path.join(dir, n), "utf8"))) out.push(`${n} has no file:line citations`);
    if (!merged.includes(`## Topic: ${topic}`)) out.push(`research.md does not include topic "${topic}" (run harness_state action=merge_research)`);
  }
  if (files.length > 1 && !/## Conflicts and gaps/.test(merged)) out.push("research.md lacks a 'Conflicts and gaps' section");
  return out;
}

const parseCitation = (c) => {
  if (typeof c !== "string" || !CITATION_RE.test(c.trim())) return null;
  const m = /^(.*):(\d+)(?:-(\d+))?$/.exec(c.trim());
  return { file: m[1].replace(/\\/g, "/"), line: Number(m[2]) };
};

/**
 * Consolidate reports/review-<lens>.json: drop findings without a valid file:line citation, de-duplicate by
 * file:line (keeping highest severity, all lenses and titles), write reports/review.md and review-consolidated.json.
 */
export function consolidateReview(cwd, fd, lensSchema, wantLenses = null) {
  const rdir = path.join(cwd, fd, "reports");
  const files = listLane(rdir, /^review-[a-z0-9-]+\.json$/).filter((n) => n !== "review-consolidated.json");
  if (!files.length) return { ok: false, error: "no reports/review-<lens>.json files" };
  const errors = [], dropped = [], map = new Map(), lenses = [];
  for (const n of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(rdir, n), "utf8")); } catch (e) { errors.push(`${n} unreadable: ${e.message}`); continue; }
    const errs = validate(lensSchema, data);
    if (errs.length) { errors.push(`${n} invalid: ${errs.slice(0, 3).join("; ")}`); continue; }
    const lens = n.replace(/^review-|\.json$/g, "");
    if (data.lens !== lens) { errors.push(`${n}: "lens" must equal "${lens}"`); continue; }
    lenses.push(lens);
    for (const f of data.findings) {
      const c = parseCitation(f.citation);
      if (!c) { dropped.push({ lens, title: f.title, reason: "no valid file:line citation" }); continue; }
      const key = `${c.file}:${c.line}`;
      const e = map.get(key) || { citation: f.citation.trim(), severity: "minor", lenses: [], titles: [], rationale: [], fix: [] };
      if (RANK[f.severity] > RANK[e.severity]) e.severity = f.severity;
      if (!e.lenses.includes(lens)) e.lenses.push(lens);
      e.titles.push(f.title); e.rationale.push(f.rationale); e.fix.push(f.fix);
      map.set(key, e);
    }
  }
  if (wantLenses) for (const l of wantLenses) if (!lenses.includes(l) && !errors.some((e) => e.startsWith(`review-${l}.json`))) errors.push(`review-${l}.json is missing`);
  if (errors.length) return { ok: false, error: errors.join("; ") };
  const findings = [...map.values()].sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const blocking = findings.filter((f) => BLOCKING.has(f.severity));
  const lensesWithBlocking = [...new Set(blocking.flatMap((f) => f.lenses))].sort();
  const verdict = blocking.length ? "changes-requested" : "approve";
  const md = [`# Review (consolidated from ${lenses.length} lenses: ${lenses.join(", ")})`, "",
    ...findings.map((f) => `- **${f.severity}** \`${f.citation}\` [${f.lenses.join(", ")}] ${[...new Set(f.titles)].join(" / ")}\n  - Problem: ${[...new Set(f.rationale)].join(" ")}\n  - Fix: ${[...new Set(f.fix)].join(" ")}`),
    ...(findings.length ? [] : ["No findings."]),
    ...(dropped.length ? ["", `Dropped (uncited): ${dropped.length}`, ...dropped.map((d) => `- ${d.lens}: ${d.title}`)] : []),
    "", `Verdict: ${verdict}`, ""].join("\n");
  fs.writeFileSync(path.join(rdir, "review.md"), md);
  fs.writeFileSync(path.join(rdir, "review-consolidated.json"), JSON.stringify({ lens: "consolidated", lenses, verdict, blocking: blocking.length, lensesWithBlocking, findings, dropped }, null, 2));
  return { ok: true, verdict, lenses, blocking: blocking.length, lensesWithBlocking, findings: findings.length, dropped: dropped.length };
}

/** Review gate: lens reports must be consolidated (fresh) with no unresolved blocking findings. */
export function reviewProblems(cwd, fd) {
  const rdir = path.join(cwd, fd, "reports");
  const files = listLane(rdir, /^review-[a-z0-9-]+\.json$/).filter((n) => n !== "review-consolidated.json");
  if (!files.length) return [];
  const cf = path.join(rdir, "review-consolidated.json");
  if (!fs.existsSync(cf)) return ["lens reviews not consolidated (run harness_state action=consolidate_review)"];
  const out = [];
  const cm = fs.statSync(cf).mtimeMs;
  for (const n of files) if (fs.statSync(path.join(rdir, n)).mtimeMs > cm + 1) out.push(`${n} is newer than the consolidated review (re-run consolidate_review)`);
  try {
    const c = JSON.parse(fs.readFileSync(cf, "utf8"));
    if (c.blocking > 0) out.push(`${c.blocking} unresolved blocking review finding(s) in lenses: ${c.lensesWithBlocking.join(", ")}`);
  } catch (e) { out.push(`review-consolidated.json unreadable: ${e.message}`); }
  return out;
}

/** Re-run rounds of blocking lenses are capped (counter review-rounds); the initial consolidation (no wantLenses) is free. */
export function reviewRerun(state, want, cap = 2) {
  if (!want || !want.length) return { ok: true, round: 0 };
  const c = state.counters["review-rounds"] || { count: 0, cap };
  c.cap = cap; c.count += 1; state.counters["review-rounds"] = c;
  if (c.count > cap) return { ok: false, error: `review re-run cap exceeded (${c.count - 1}/${cap} rounds used): stop and escalate to the user with the remaining blocking findings` };
  return { ok: true, round: c.count };
}

/** Files changed on the feature branch vs its base (state.worktree.base unless it is HEAD/missing, then the default branch); merge-base diff so base-branch progress is ignored. */
export function reviewChangedFiles(cwd, wtBase, fallbackBase) {
  const base = wtBase && wtBase !== "HEAD" ? wtBase : fallbackBase;
  try { return execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").map((s) => s.trim()).filter(Boolean); } catch { return []; }
}
