import fs from "node:fs";
import path from "node:path";
import { validate } from "./jsonschema.mjs";

/** Holdout scenarios (StrongDM-style): e2e behavioural checks that only the verifier (and their author) may read. */
export const HOLDOUT_DIR = "holdout";
export const HOLDOUT_RE = /(^|\/)\.ai\/[^/]+\/holdout(\/|$)/;

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

const HOLDOUT_ALLOWED = ["relay-verifier", "relay-spec-writer"];

/** Heuristic bash/search guard: non-allowed roles may not mention the holdout dir in a command or search path. Best-effort (command text can be obfuscated). */
export function holdoutAccessProblem(role, text) {
  if (HOLDOUT_ALLOWED.includes(role)) return null;
  const s = String(text || "");
  // The orchestrator's own commands may merely mention the word (e.g. requirement text); only path-like references are blocked for it.
  const hit = role === "relay" ? /holdout[\\/]|[\\/]+holdout\b/i.test(s) : /holdout/i.test(s);
  return hit ? "holdout scenarios are hidden: only the verifier may access holdout/" : null;
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
