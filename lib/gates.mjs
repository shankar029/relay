import fs from "node:fs";
import path from "node:path";
import { validate } from "./jsonschema.mjs";
import { checkPlan } from "./plan.mjs";
import { holdoutAuthoringProblems, holdoutResultProblems } from "./holdout.mjs";
import { lintSpec } from "./speclint.mjs";
import { lessonWarnings } from "./speclessons.mjs";
import { researchProblems, reviewProblems } from "./fanout.mjs";

const PHASE_ORDER = ["baseline", "requirement", "research", "spec", "spec-approval", "design", "design-review", "design-approval", "implement", "verify", "review", "pr", "done"];
const idx = (p) => PHASE_ORDER.indexOf(p);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const nonEmpty = (f) => fs.existsSync(f) && fs.statSync(f).size >= 20;

const approved = (state, re) => Object.entries(state.approvals || {}).some(([k, v]) => re.test(k) && v === "approved");

/** Every scenario passes and every evidence path exists, is non-empty and is under evidence/. */
export function featureProblems(cwd, featureDir, features) {
  const out = [];
  for (const it of features.items) for (const sc of it.scenarios) {
    if (!sc.passes) { out.push(`scenario ${it.name}/${sc.name} does not pass`); continue; }
    const ev = sc.evidence || [];
    if (!ev.length) out.push(`scenario ${it.name}/${sc.name} passes but has no evidence`);
    for (const e of ev) {
      const abs = path.join(cwd, e);
      if (!e.startsWith(`${featureDir}/evidence/`) || !fs.existsSync(abs) || fs.statSync(abs).size === 0) out.push(`scenario ${it.name}/${sc.name}: evidence ${e} missing/empty`);
    }
  }
  return out;
}

/** Required computational checks (relay.config.json requiredChecks, e.g. lint, sast, test) must be configured and last ran green on the current HEAD. */
export function checkProblems(state, required = [], head = null) {
  const out = [];
  for (const n of required) {
    const r = state.checkResults?.[n];
    if (!state.checks?.[n]) out.push(`required check "${n}" is not configured (harness_state action=checks)`);
    else if (!r) out.push(`required check "${n}" has not been run via relay_checks`);
    else if (!r.ok) out.push(`required check "${n}" last run FAILED`);
    else if (head && r.head !== head) out.push(`required check "${n}" is stale (ran on ${String(r.head).slice(0, 8)}, HEAD is ${head.slice(0, 8)}); re-run relay_checks`);
  }
  return out;
}
/**
 * Content/state gates for entering `phase`, beyond artefact existence. Returns problem strings.
 * schemas = { features, plan, holdout?, holdoutResults? }. threshold = minimum holdout satisfaction (0..1, default 1 = all must pass).
 */
export function phaseProblems({ phase, cwd, featureDir, state, schemas, threshold = 1, requiredChecks = [], head = null, requiredApprovals = ["spec", "design"], lessons = [] }) {
  const at = idx(phase);
  const f = (n) => path.join(cwd, featureDir, n);
  const out = [];
  if (at >= idx("spec")) out.push(...researchProblems(cwd, featureDir));
  if (at >= idx("spec-approval")) {
    if (!nonEmpty(f("spec.md"))) out.push("spec.md is empty");
    try {
      const fe = readJson(f("features.json"));
      const errs = validate(schemas.features, fe);
      if (errs.length) out.push(`features.json invalid: ${errs.slice(0, 3).join("; ")}`);
      else out.push(...[...lintSpec(fe), ...lessonWarnings(fe, lessons)].map((w) => `spec-lint: ${w}`));
    } catch (e) { out.push(`features.json unreadable: ${e.message}`); }
    if (schemas.holdout) out.push(...holdoutAuthoringProblems(cwd, featureDir, schemas.holdout));
  }
  if (at >= idx("design") && requiredApprovals.includes("spec") && !approved(state, /spec/i)) out.push("spec has not been approved (relay_approval 'spec' must be approved)");
  if (at >= idx("design-review")) {
    if (!nonEmpty(f("design.md"))) out.push("design.md is empty");
    try {
      const pl = readJson(f("plan.json"));
      const errs = validate(schemas.plan, pl);
      out.push(...(errs.length ? errs.slice(0, 3) : checkPlan(pl)).map((e) => `plan.json: ${e}`));
    } catch (e) { out.push(`plan.json unreadable: ${e.message}`); }
  }
  if (at >= idx("done") && requiredApprovals.includes("pr") && !approved(state, /^pr/i)) out.push("pr has not been approved (relay_approval \"pr\" must be approved at autonomy=supervised)");
  if (at >= idx("implement") && requiredApprovals.includes("design") && !approved(state, /design/i)) out.push("design has not been approved (relay_approval 'design' must be approved)");
  if (at >= idx("verify")) {
    try {
      const pl = readJson(f("plan.json"));
      const open = pl.slices.filter((s) => state.slices?.[s.id]?.status !== "merged").map((s) => s.id);
      if (open.length) out.push(`slices not merged: ${open.join(", ")} (record with harness_state slice status=merged)`);
    } catch { /* reported above */ }
    const running = Object.entries(state.steps || {}).filter(([, s]) => s.status === "running").map(([k]) => k);
    if (running.length) out.push(`steps still running: ${running.join(", ")}`);
  }
  if (at >= idx("review")) {
    out.push(...checkProblems(state, requiredChecks, head));
    let reports = [];
    try { reports = fs.readdirSync(f("reports")).filter((n) => /^verify-.*\.json$/.test(n)); } catch { /* none */ }
    if (!reports.length) out.push("no reports/verify-<n>.json from the verifier");
    try { out.push(...featureProblems(cwd, featureDir, readJson(f("features.json")))); } catch { /* reported above */ }
    if (schemas.holdoutResults) out.push(...holdoutResultProblems(cwd, featureDir, schemas, threshold).problems);
  }
  if (at >= idx("pr")) {
    if (!nonEmpty(f("reports/review.md"))) out.push("reports/review.md is missing/empty");
    out.push(...reviewProblems(cwd, featureDir));
  }
  if (phase === "done") {
    const pr = fs.existsSync(f("pr.md")) ? fs.readFileSync(f("pr.md"), "utf8") : "";
    for (const h of ["Summary", "Traceability", "Verification", "Review", "Caveats", "gh pr create"]) if (!pr.includes(h)) out.push(`pr.md lacks "${h}" (generate it with harness_state action=pr_draft)`);
  }
  return out;
}

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** Deterministic pr.md; the orchestrator supplies only summary and caveats. */
export function renderPr({ slug, title, summary, caveats = [], features, featureDir, branch, base, checks = [], commits = [], diffStat = "", reviewExcerpt = "", verifyReports = [], satisfaction = null }) {
  const rows = [];
  for (const it of features.items) for (const sc of it.scenarios) {
    rows.push(`| ${cell(it.title)} | ${cell(sc.name)} | ${sc.passes ? "pass" : "FAIL"} | ${(sc.evidence || []).map((e) => `\`${e}\``).join(", ") || "-"} |`);
  }
  const body = [
    `# ${title}`,
    `## Summary\n${summary}`,
    `## Traceability (spec item -> scenario -> evidence)\n| Spec item | Scenario | Result | Evidence |\n|---|---|---|---|\n${rows.join("\n")}`,
    `## Verification\n${checks.length ? checks.map((c) => `- ${c}`).join("\n") : "- (no relay_checks logs found)"}\n${verifyReports.map((r) => `- verifier report: \`${r}\``).join("\n")}\n${satisfaction ? `- holdout satisfaction: ${satisfaction.passed}/${satisfaction.total} (${(satisfaction.score * 100).toFixed(0)}%; hidden scenarios, not committed; the per-scenario \`passes\` gate above stays authoritative)${satisfaction.failing.length ? `; failing: ${satisfaction.failing.join(", ")}` : ""}\n` : ""}- artefacts: \`${featureDir}/\` (spec.md, design.md, plan.json, features.json)`,
    `## Review\n${reviewExcerpt || "See reports/review.md"}\n\nFull review: \`${featureDir}/reports/review.md\``,
    `## Caveats\n${caveats.length ? caveats.map((c) => `- ${c}`).join("\n") : "- none reported"}`,
    `## Commits\n${commits.map((c) => `- ${c}`).join("\n")}\n\n\`\`\`\n${diffStat}\n\`\`\``,
    `## Create the PR (not run by Relay)\n\`\`\`sh\ngit push -u origin ${branch}\ngh pr create --base ${base} --head ${branch} --title ${JSON.stringify(title)} --body-file ${featureDir}/pr.md\n\`\`\``,
  ];
  return body.join("\n\n") + "\n";
}
