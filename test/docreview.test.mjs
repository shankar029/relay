import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { laneInfo, docLaneProblem, docReviewConfig, consolidateDocReview, docReviewRound, resolveDocReview, closeDocReview, docReviewProblems, DOC_LENSES } from "../lib/docreview.mjs";
import { laneProblem } from "../lib/fanout.mjs";
import { requiredOutputs, checkWrite, checkRead, isLayoutFile } from "../lib/policy.mjs";
import { phaseProblems } from "../lib/gates.mjs";

const schema = JSON.parse(fs.readFileSync(new URL("../schemas/docreview-lens.schema.json", import.meta.url), "utf8"));
const fd = ".ai/demo";
const mk = () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dr-"));
  fs.mkdirSync(path.join(cwd, fd, "reports"), { recursive: true });
  fs.writeFileSync(path.join(cwd, fd, "spec.md"), "# Spec\n\n## Goal\nx\n\n## Retry policy\ny\n");
  fs.writeFileSync(path.join(cwd, "code.js"), "a\nb\n");
  return cwd;
};
const f = (severity, scope, title) => ({ severity, scope, title, rationale: "because", recommendation: "do x" });
const report = (cwd, doc, lens, findings, extra = {}) =>
  fs.writeFileSync(path.join(cwd, fd, "reports", `docreview-${doc}-${lens}.json`), JSON.stringify({ doc, lens, findings, ...extra }));
const all = (cwd, per = {}) => {
  for (const l of DOC_LENSES.spec) report(cwd, "spec", l, per[l] || [], l === "comprehension" ? { paraphrase: "A feature that does a thing for users so they can do other things." } : {});
};

test("lanes are <doc>-<lens>; the lane set is validated and shares the fan-out checks", () => {
  assert.deepEqual(laneInfo("spec-critic"), { doc: "spec", lens: "critic" });
  assert.equal(laneInfo("spec-readiness"), null);
  assert.equal(laneInfo("design-readiness").lens, "readiness");
  const t = (lane) => ({ agent: "relay-doc-reviewer", lane });
  assert.equal(laneProblem([t("spec-critic"), t("spec-style")]), null);
  assert.match(laneProblem([t("critic")]), /lane must be/);
  assert.match(laneProblem([t("spec-critic"), t("spec-critic")]), /duplicate/);
  assert.match(laneProblem([t("spec-critic"), t("design-critic")]), /one document/);
  assert.match(laneProblem([{ agent: "relay-doc-reviewer" }]), /lane/);
  assert.match(laneProblem([{ agent: "relay-implementor", lane: "x" }]), /only for/);
  assert.match(docLaneProblem([t("spec-nope")]), /known lens/);
});

test("config: lenses restricted to known ones, default cap 3, can be disabled", () => {
  assert.deepEqual(docReviewConfig({}, "spec"), { enabled: true, maxRounds: 3, lenses: DOC_LENSES.spec });
  const c = docReviewConfig({ docReview: { enabled: false, maxRounds: 2, lenses: { spec: ["critic", "bogus"] } } }, "spec");
  assert.deepEqual([c.enabled, c.maxRounds, c.lenses], [false, 2, ["critic"]]);
});

test("policy: output path, write scope and fresh-context read guard", () => {
  assert.deepEqual(requiredOutputs("relay-doc-reviewer", fd, undefined, "spec-critic"), [`${fd}/reports/docreview-spec-critic.json`]);
  assert.equal(checkWrite({ role: "relay-doc-reviewer", rel: `${fd}/reports/docreview-design-codebase.json`, featureDir: fd }), null);
  for (const rel of [`${fd}/spec.md`, "src/a.js", `${fd}/reports/docreview-spec-consolidated.json`, `${fd}/reports/docreview-spec-state.json`]) assert.ok(checkWrite({ role: "relay-doc-reviewer", rel, featureDir: fd }), rel);
  for (const rel of [`${fd}/requirement.md`, `${fd}/concepts.md`, `${fd}/decisions.md`, `${fd}/research.md`, `${fd}/reports/docreview-spec-critic.json`, `${fd}/holdout/scenarios.json`]) assert.ok(checkRead({ role: "relay-doc-reviewer", rel }), rel);
  for (const rel of [`${fd}/spec.md`, `${fd}/design.md`, "AGENTS.md", "src/a.js"]) assert.equal(checkRead({ role: "relay-doc-reviewer", rel }), null, rel);
  assert.equal(checkWrite({ role: "relay", rel: `${fd}/concepts.md`, featureDir: fd }), null);
  assert.ok(isLayoutFile(`${fd}/concepts.md`, fd) && isLayoutFile(`${fd}/reports/docreview-spec-report.md`, fd) && isLayoutFile(`${fd}/reports/docreview-spec-state.json`, fd));
});

test("consolidate: dedupe, drop unscoped, missing reviewer is not a zero-finding review, comprehension needs a paraphrase", () => {
  const cwd = mk();
  report(cwd, "spec", "critic", [f("major", "Retry policy", "No backoff")]);
  let r = consolidateDocReview(cwd, fd, "spec", schema, { round: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not run/);
  all(cwd, { critic: [f("major", "Retry policy", "No backoff"), f("minor", "Goal", "Vague")], structural: [f("blocker", "retry POLICY", "no backoff")] });
  fs.writeFileSync(path.join(cwd, fd, "reports", "docreview-spec-style.json"), JSON.stringify({ doc: "spec", lens: "style", findings: [{ ...f("minor", "x", "y"), scope: "  " }] }));
  r = consolidateDocReview(cwd, fd, "spec", schema, { round: 1 });
  assert.equal(r.dropped, 1);
  report(cwd, "spec", "style", []);
  report(cwd, "spec", "comprehension", [], { paraphrase: "short" });
  assert.match(consolidateDocReview(cwd, fd, "spec", schema, { round: 1 }).error, /paraphrase/);
  report(cwd, "spec", "comprehension", [], { paraphrase: "A feature that does a thing for users so they can do other things." });
  r = consolidateDocReview(cwd, fd, "spec", schema, { round: 1 });
  assert.deepEqual([r.ok, r.findings, r.blocking, r.clean], [true, 2, 1, false]);
  const c = JSON.parse(fs.readFileSync(path.join(cwd, fd, "reports", "docreview-spec-consolidated.json"), "utf8"));
  assert.equal(c.findings[0].severity, "blocker");
  assert.deepEqual(c.findings[0].lenses.sort(), ["critic", "structural"]);
  assert.equal(c.findings[0].id, "spec-r1-1");
  assert.ok(fs.existsSync(path.join(cwd, fd, "reports", "docreview-spec-report.md")));
});

test("resolve: every finding classified, contests need checkable evidence, comprehension gaps and non-minor declines refused", () => {
  const cwd = mk();
  all(cwd, { critic: [f("major", "Retry policy", "No backoff")], comprehension: [f("major", "Goal", "Undefined term")], style: [f("minor", "Goal", "Wordy")] });
  consolidateDocReview(cwd, fd, "spec", schema, { round: 1 });
  const c = JSON.parse(fs.readFileSync(path.join(cwd, fd, "reports", "docreview-spec-consolidated.json"), "utf8"));
  const id = (t) => c.findings.find((x) => x.title === t).id;
  const j = "reason";
  assert.match(resolveDocReview(cwd, fd, "spec", []).error, /no decision/);
  assert.match(resolveDocReview(cwd, fd, "spec", [{ id: id("No backoff"), action: "decline", justification: j }, { id: id("Undefined term"), action: "contest", justification: j, evidence: "Goal" }, { id: id("Wordy"), action: "fix", justification: j }]).error, /comprehension gap[\s\S]*only minor/);
  assert.match(resolveDocReview(cwd, fd, "spec", [{ id: id("No backoff"), action: "contest", justification: j, evidence: "it was intentional" }, { id: id("Undefined term"), action: "fix", justification: j }, { id: id("Wordy"), action: "decline", justification: j }]).error, /checkable evidence/);
  const ok = resolveDocReview(cwd, fd, "spec", [{ id: id("No backoff"), action: "contest", justification: j, evidence: "section: Retry policy" }, { id: id("Undefined term"), action: "fix", justification: j }, { id: id("Wordy"), action: "decline", justification: j }]);
  assert.deepEqual([ok.ok, ok.fix, ok.contest, ok.decline], [true, 1, 1, 1]);
  const ok2 = resolveDocReview(cwd, fd, "spec", [{ id: id("No backoff"), action: "contest", justification: j, evidence: "code.js:1" }, { id: id("Undefined term"), action: "escalate", justification: j }, { id: id("Wordy"), action: "decline", justification: j }]);
  assert.deepEqual(ok2.escalated, [id("Undefined term")]);
});

test("rounds: a settled finding does not block, a clean round converges, a fixed finding that returns is flagged, cap enforced", () => {
  const cwd = mk();
  all(cwd, { critic: [f("major", "Retry policy", "No backoff"), f("blocker", "Goal", "Unclear goal")] });
  consolidateDocReview(cwd, fd, "spec", schema, { round: 1 });
  const c1 = JSON.parse(fs.readFileSync(path.join(cwd, fd, "reports", "docreview-spec-consolidated.json"), "utf8"));
  const [a, b] = [c1.findings.find((x) => x.title === "No backoff").id, c1.findings.find((x) => x.title === "Unclear goal").id];
  resolveDocReview(cwd, fd, "spec", [{ id: a, action: "contest", justification: "j", evidence: "section: Retry policy" }, { id: b, action: "fix", justification: "j" }]);
  assert.match(docReviewProblems(cwd, fd, "spec")[0], /not converged/);
  all(cwd, { critic: [f("major", "Retry policy", "No backoff"), f("blocker", "Goal", "Unclear goal")] });
  const r2 = consolidateDocReview(cwd, fd, "spec", schema, { round: 2 });
  assert.deepEqual([r2.clean, r2.reopened, r2.blocking], [false, 1, 1]);
  all(cwd, { critic: [f("major", "Retry policy", "No backoff")], style: [f("minor", "Goal", "Wordy")] });
  const r3 = consolidateDocReview(cwd, fd, "spec", schema, { round: 3 });
  assert.deepEqual([r3.clean, r3.status], [true, "converged"]);
  assert.deepEqual(docReviewProblems(cwd, fd, "spec"), []);
  const st = { counters: {} };
  assert.equal(docReviewRound(st, "spec", 2).round, 1);
  assert.equal(docReviewRound(st, "spec", 2).round, 2);
  assert.match(docReviewRound(st, "spec", 2).error, /cap exceeded/);
});

test("gate: review required until converged, accepted or skipped with a reason; disabled by config", () => {
  const cwd = mk();
  assert.match(docReviewProblems(cwd, fd, "spec")[0], /has not been through/);
  assert.deepEqual(docReviewProblems(cwd, fd, "spec", false), []);
  assert.equal(closeDocReview(cwd, fd, "spec", "accept", "ok").ok, false);
  assert.equal(closeDocReview(cwd, fd, "spec", "skip", " ").ok, false);
  assert.equal(closeDocReview(cwd, fd, "spec", "skip", "one-line spec").status, "skipped");
  assert.deepEqual(docReviewProblems(cwd, fd, "spec"), []);
  all(cwd, { critic: [f("blocker", "Goal", "Bad")] });
  const cwd2 = mk();
  all(cwd2, { critic: [f("blocker", "Goal", "Bad")] });
  consolidateDocReview(cwd2, fd, "spec", schema, { round: 1 });
  assert.equal(closeDocReview(cwd2, fd, "spec", "accept", "accepted trade-off").status, "accepted");
  assert.deepEqual(docReviewProblems(cwd2, fd, "spec"), []);
});

test("phaseProblems enforces the document review only when enabled", () => {
  const cwd = mk();
  fs.writeFileSync(path.join(cwd, fd, "features.json"), "{}");
  const base = { phase: "spec-approval", cwd, featureDir: fd, state: {}, schemas: { features: { type: "object" }, plan: {} } };
  assert.ok(!phaseProblems(base).some((p) => /document review|fresh-context/.test(p)));
  assert.ok(phaseProblems({ ...base, docReview: true }).some((p) => /fresh-context document review/.test(p)));
  const d = phaseProblems({ ...base, phase: "design-approval", state: { approvals: { spec: "approved" } }, docReview: true });
  assert.ok(d.some((p) => /design has not been through/.test(p)));
});

test("consolidate: near-duplicate findings from different lenses merge, unrelated ones stay apart", () => {
  const cwd = mk();
  all(cwd, {
    critic: [f("major", "Overdue list", "dueDate is optional but POST requires it"), f("minor", "Goal", "Vague wording")],
    structural: [f("blocker", "Overdue list endpoint", "POST requires dueDate although it is optional")],
    style: [f("minor", "Data model", "Totally different retention concern")],
  });
  const r = consolidateDocReview(cwd, fd, "spec", schema, { round: 1 });
  assert.equal(r.findings, 3);
  const cons = JSON.parse(fs.readFileSync(path.join(cwd, fd, "reports", "docreview-spec-consolidated.json"), "utf8"));
  const merged = cons.findings.find((x) => x.lenses.length === 2);
  assert.equal(merged.severity, "blocker");
});