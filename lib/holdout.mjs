import fs from "node:fs";
import path from "node:path";
import { validate } from "./jsonschema.mjs";

/** Holdout scenarios (StrongDM-style): e2e behavioural checks that only the verifier (and their author) may read. */
export const HOLDOUT_DIR = "holdout";
export const HOLDOUT_RE = /(^|\/)\.ai\/[^/]+\/holdout(\/|$)/;

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

const HOLDOUT_ALLOWED = ["relay-verifier", "relay-spec-writer"];

/** Strip shell quoting/escaping/concatenation so `ho""ldout`, `h\oldout`, `'ho'+'ldout'` collapse to `holdout`. */
const deobfuscate = (s) => s.replace(/\\x[0-9a-f]{2}|\\[0-7]{3}/gi, "?").replace(/["'`\\+]|\$\{?\}?|\s*\.\.?\s*(?=["'])/g, "");

// Wildcard forms that can reach holdout/ without naming it: h*, ho?dout, [h]oldout, .ai/*/*, .ai/**
const GLOB_RE = /\bh[\w*?\[\]-]*\*[\w*?\[\]-]*|\bho[\w*?\[\]-]*\?[\w*?\[\]-]*out|\[h\]|\.ai[\\/]+(\*|\[)|\.ai[\\/]+[^\s\\/]+[\\/]+[*?\[]/i;
// Runtime string construction / decoding used to hide a path.
const DECODE_RE = /\bbase64\b\s+(-d|--decode)|\beval\b|\bxxd\s+-r|\bFromBase64String\b|\[char\]|\bIEX\b|\bInvoke-Expression\b|\\x[0-9a-f]{2}|printf\s+['"][^'"]*\\[0-7x]/i;

/** Heuristic bash/search guard: non-allowed roles may not reach the holdout dir via a command or search path. Best-effort, hardened against quoting, globbing and decoding tricks. */
export function holdoutAccessProblem(role, text) {
  if (HOLDOUT_ALLOWED.includes(role)) return null;
  const raw = String(text || "");
  const s = deobfuscate(raw);
  const msg = "holdout scenarios are hidden: only the verifier may access holdout/";
  // The orchestrator's own commands may merely mention the word (e.g. requirement text); only path-like references are blocked for it.
  const named = role === "relay" ? /holdout[\\/]|[\\/]+holdout\b/i.test(s) : /holdout/i.test(s);
  if (named) return msg;
  if (role === "relay") return null;
  if (/scenarios\.json/i.test(s)) return `${msg} (scenarios.json is verifier-only)`;
  if (/\$\(|`|\beval\b|\$\{/.test(raw) && /\.ai\b|scenarios|hold|out\b/i.test(raw)) return `${msg} (command substitution near .ai/)`;
  if (GLOB_RE.test(s) && /\.ai\b/i.test(s)) return `${msg} (wildcard access to .ai/ is not allowed for this role)`;
  if (DECODE_RE.test(raw) && /\.ai\b/i.test(raw)) return `${msg} (obfuscated path construction near .ai/)`;
  return null;
}
/** Fraction of holdout scenarios that passed (blocked/missing count as not satisfied). */
export function satisfaction(scenarios, results) {
  if (!scenarios.length) return { score: 0, passed: 0, total: 0, failing: [] };
  const byName = new Map(results.map((r) => [r.scenario, r]));
  const failing = scenarios.filter((s) => byName.get(s.name)?.result !== "pass").map((s) => s.name);
  const passed = scenarios.length - failing.length;
  return { score: passed / scenarios.length, passed, total: scenarios.length, failing };
}

/** Problems with holdout/scenarios.json (authoring stage). */
export function holdoutAuthoringProblems(cwd, featureDir, schema) {
  const f = path.join(cwd, featureDir, HOLDOUT_DIR, "scenarios.json");
  if (!fs.existsSync(f)) return [`${featureDir}/holdout/scenarios.json is missing (spec-writer must author holdout scenarios)`];
  try {
    const errs = validate(schema, readJson(f));
    return errs.length ? [`holdout/scenarios.json invalid: ${errs.slice(0, 3).join("; ")}`] : [];
  } catch (e) { return [`holdout/scenarios.json unreadable: ${e.message}`]; }
}

/**
 * Problems with holdout results (verification stage): every scenario has a result, passes carry
 * non-empty evidence under holdout/evidence/, and the satisfaction score meets `threshold`.
 * Returns { problems, sat }.
 */
export function holdoutResultProblems(cwd, featureDir, schemas, threshold = 1) {
  const dir = path.join(cwd, featureDir, HOLDOUT_DIR);
  const out = [];
  let scenarios = [], results = [];
  try { scenarios = readJson(path.join(dir, "scenarios.json")).scenarios; } catch (e) { return { problems: [`holdout/scenarios.json unreadable: ${e.message}`], sat: null }; }
  const rf = path.join(dir, "results.json");
  if (!fs.existsSync(rf)) return { problems: [`${featureDir}/holdout/results.json is missing (verifier must run the holdout scenarios)`], sat: null };
  try {
    const data = readJson(rf);
    const errs = validate(schemas.holdoutResults, data);
    if (errs.length) return { problems: [`holdout/results.json invalid: ${errs.slice(0, 3).join("; ")}`], sat: null };
    results = data.results;
  } catch (e) { return { problems: [`holdout/results.json unreadable: ${e.message}`], sat: null }; }
  const names = new Set(scenarios.map((s) => s.name));
  const seen = new Set(results.map((r) => r.scenario));
  for (const n of names) if (!seen.has(n)) out.push(`holdout scenario "${n}" has no result`);
  for (const r of results) {
    if (!names.has(r.scenario)) out.push(`holdout result for unknown scenario "${r.scenario}"`);
    if (r.result !== "pass") continue;
    const ev = r.evidence || [];
    if (!ev.length) out.push(`holdout scenario "${r.scenario}" passes but has no evidence`);
    for (const e of ev) {
      const abs = path.join(cwd, e);
      if (!e.startsWith(`${featureDir}/holdout/evidence/`) || !fs.existsSync(abs) || fs.statSync(abs).size === 0) out.push(`holdout scenario "${r.scenario}": evidence ${e} missing/empty`);
    }
  }
  // A pass without valid evidence does not count towards the score.
  const credible = results.filter((r) => r.result === "pass" && (r.evidence || []).length && r.evidence.every((e) => e.startsWith(`${featureDir}/holdout/evidence/`) && fs.existsSync(path.join(cwd, e)) && fs.statSync(path.join(cwd, e)).size > 0));
  const sat = satisfaction(scenarios, credible);
  if (sat.score < threshold) out.push(`holdout satisfaction ${sat.passed}/${sat.total} (${(sat.score * 100).toFixed(0)}%) is below threshold ${(threshold * 100).toFixed(0)}%; failing: ${sat.failing.join(", ")}`);
  return { problems: out, sat };
}
