import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRead, checkWrite, requiredOutputs, isLayoutFile } from "../lib/policy.mjs";
import { satisfaction, holdoutAccessProblem, holdoutAuthoringProblems, holdoutResultProblems } from "../lib/holdout.mjs";
import { phaseProblems, renderPr } from "../lib/gates.mjs";
import { lintSpec } from "../lib/speclint.mjs";
import { validate } from "../lib/jsonschema.mjs";

const root = path.resolve(import.meta.dirname, "..");
const schema = (n) => JSON.parse(fs.readFileSync(path.join(root, "schemas", `${n}.schema.json`), "utf8"));
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", n), "utf8"));
const FD = ".ai/feat";
const schemas = { holdout: schema("holdout"), holdoutResults: schema("holdout-results") };

function tmp() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-holdout-"));
  fs.mkdirSync(path.join(cwd, FD, "holdout", "evidence"), { recursive: true });
  fs.writeFileSync(path.join(cwd, FD, "holdout", "scenarios.json"), JSON.stringify(fixture("holdout.sample.json")));
  return cwd;
}
function writeResults(cwd, results, evidence = true) {
  for (const r of results) {
    if (evidence && r.result === "pass") fs.writeFileSync(path.join(cwd, FD, "holdout", "evidence", `${r.scenario}.txt`), "ok");
    r.evidence = r.result === "pass" ? [`${FD}/holdout/evidence/${r.scenario}.txt`] : [];
  }
  fs.writeFileSync(path.join(cwd, FD, "holdout", "results.json"), JSON.stringify({ results }));
}
const names = ["empty-input-rejected", "duplicate-item-conflict", "delete-then-get-missing"];
const res = (...r) => names.map((n, i) => ({ scenario: n, result: r[i] }));

test("read guard hides holdout from all but verifier and spec-writer", () => {
  for (const role of ["relay-implementor", "relay-reviewer", "relay-architect", "relay-researcher", "relay"]) {
    assert.ok(checkRead({ role, rel: `${FD}/holdout/scenarios.json` }), role);
    assert.ok(checkRead({ role, rel: `/abs/wt/${FD}/holdout/evidence/x.txt` }), role);
  }
  assert.equal(checkRead({ role: "relay-verifier", rel: `${FD}/holdout/scenarios.json` }), null);
  assert.equal(checkRead({ role: "relay-implementor", rel: `${FD}/spec.md` }), null);
});

test("write guard, layout and required outputs", () => {
  assert.equal(checkWrite({ role: "relay-spec-writer", rel: `${FD}/holdout/scenarios.json`, featureDir: FD }), null);
  assert.ok(checkWrite({ role: "relay-implementor", rel: `${FD}/holdout/results.json`, featureDir: FD, owned: ["src/**"] }));
  assert.equal(checkWrite({ role: "relay-verifier", rel: `${FD}/holdout/results.json`, featureDir: FD }), null);
  assert.equal(checkWrite({ role: "relay-verifier", rel: `${FD}/holdout/evidence/a.txt`, featureDir: FD }), null);
  assert.ok(isLayoutFile(`${FD}/holdout/scenarios.json`, FD));
  assert.ok(requiredOutputs("relay-spec-writer", FD).includes(`${FD}/holdout/scenarios.json`));
});

test("text guard blocks holdout mentions for non-allowed roles", () => {
  assert.ok(holdoutAccessProblem("relay-implementor", "cat .ai/x/holdout/scenarios.json"));
  assert.ok(holdoutAccessProblem("relay-reviewer", "grep -r HOLDOUT ."));
  assert.equal(holdoutAccessProblem("relay-verifier", "cat holdout/scenarios.json"), null);
  assert.equal(holdoutAccessProblem("relay-implementor", "npm test"), null);
  assert.equal(holdoutAccessProblem("relay", "cat > requirement.md <<EOF\na spec with holdout scenarios\nEOF"), null);
  assert.ok(holdoutAccessProblem("relay", "cat .ai/x/holdout/scenarios.json"));
});

test("schemas validate fixtures and reject bad data", () => {
  assert.deepEqual(validate(schemas.holdout, fixture("holdout.sample.json")), []);
  assert.deepEqual(validate(schemas.holdoutResults, fixture("holdout-results.sample.json")), []);
  assert.ok(validate(schemas.holdout, { scenarios: fixture("holdout.sample.json").scenarios.slice(0, 2) }).length);
  assert.ok(validate(schemas.holdoutResults, { results: [{ scenario: "a", result: "maybe", evidence: [] }] }).length);
});

test("satisfaction counts only passes", () => {
  const sc = names.map((name) => ({ name }));
  const s = satisfaction(sc, [{ scenario: names[0], result: "pass" }, { scenario: names[1], result: "fail" }]);
  assert.equal(s.passed, 1);
  assert.equal(s.total, 3);
  assert.deepEqual(s.failing, [names[1], names[2]]);
  assert.equal(satisfaction([], []).score, 0);
});

test("authoring and result gates", () => {
  const cwd = tmp();
  assert.deepEqual(holdoutAuthoringProblems(cwd, FD, schemas.holdout), []);
  assert.ok(holdoutResultProblems(cwd, FD, schemas).problems[0].includes("results.json is missing"));
  writeResults(cwd, res("pass", "fail", "pass"));
  const r = holdoutResultProblems(cwd, FD, schemas);
  assert.equal(r.sat.passed, 2);
  assert.ok(r.problems.some((p) => p.includes("below threshold")));
  assert.deepEqual(holdoutResultProblems(cwd, FD, schemas, 0.6).problems, []);
  writeResults(cwd, res("pass", "pass", "pass"));
  assert.deepEqual(holdoutResultProblems(cwd, FD, schemas).problems, []);
  fs.rmSync(path.join(cwd, FD, "holdout", "evidence", `${names[0]}.txt`));
  const bad = holdoutResultProblems(cwd, FD, schemas);
  assert.ok(bad.problems.some((p) => p.includes("missing/empty")));
  assert.equal(bad.sat.passed, 2);
  fs.rmSync(path.join(cwd, FD, "holdout", "scenarios.json"));
  assert.ok(holdoutAuthoringProblems(cwd, FD, schemas.holdout)[0].includes("missing"));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("review phase gate requires holdout results; pr shows satisfaction", () => {
  const cwd = tmp();
  const base = { cwd, featureDir: FD, state: { slices: {}, steps: {}, approvals: [] }, schemas: { holdoutResults: schemas.holdoutResults } };
  const probs = phaseProblems({ ...base, phase: "review" });
  assert.ok(probs.some((p) => p.includes("results.json is missing")));
  writeResults(cwd, res("pass", "pass", "pass"));
  assert.ok(!phaseProblems({ ...base, phase: "review" }).some((p) => p.startsWith("holdout")));
  const sat = holdoutResultProblems(cwd, FD, schemas, 0).sat;
  const md = renderPr({ slug: "feat", title: "t", summary: "s", features: { items: [] }, featureDir: FD, branch: "b", base: "main", satisfaction: sat });
  assert.match(md, /holdout satisfaction: 3\/3/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("spec lint flags vague or unobservable scenarios", () => {
  const ok = { items: [{ name: "a", scenarios: [{ name: "s", steps: ["POST /x", "expect HTTP 201"] }] }] };
  assert.deepEqual(lintSpec(ok), []);
  const bad = { items: [{ name: "a", scenarios: [{ name: "s", steps: ["do it quickly", "handle things etc."] }, { name: "t", steps: [] }] }, { name: "b", scenarios: [] }] };
  const w = lintSpec(bad);
  assert.ok(w.some((x) => x.includes("ambiguous")));
  assert.ok(w.some((x) => x.includes("no steps")));
  assert.ok(w.some((x) => x.includes("no scenarios")));
});
