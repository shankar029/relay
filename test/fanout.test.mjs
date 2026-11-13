import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRead, checkWrite, requiredOutputs, isLayoutFile } from "../lib/policy.mjs";
import { laneProblem, reviewLenses, mergeResearch, researchProblems, consolidateReview, reviewProblems } from "../lib/fanout.mjs";

const FD = ".ai/f";
const schema = JSON.parse(fs.readFileSync(new URL("../schemas/review-lens.schema.json", import.meta.url), "utf8"));
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "fan-")); fs.mkdirSync(path.join(d, FD, "reports"), { recursive: true }); return d; };
const w = (d, rel, s) => fs.writeFileSync(path.join(d, FD, rel), typeof s === "string" ? s : JSON.stringify(s));
const lens = (l, findings) => ({ lens: l, findings });
const fnd = (severity, citation, title = "t") => ({ severity, citation, title, rationale: "r", fix: "f" });

test("policy: lane outputs, writes and layout", () => {
  assert.deepEqual(requiredOutputs("relay-researcher", FD, undefined, "api").map(String), [`${FD}/research-api.md`]);
  assert.deepEqual(requiredOutputs("relay-reviewer", FD, undefined, "security").map(String), [`${FD}/reports/review-security.json`]);
  assert.equal(checkWrite({ role: "relay-researcher", rel: `${FD}/research-data-layer.md`, featureDir: FD }), null);
  assert.equal(checkWrite({ role: "relay-reviewer", rel: `${FD}/reports/review-tests.json`, featureDir: FD }), null);
  assert.ok(checkWrite({ role: "relay-reviewer", rel: `${FD}/reports/review-consolidated.json`, featureDir: FD }));
  assert.ok(isLayoutFile(`${FD}/research-ui.md`, FD));
  assert.ok(isLayoutFile(`${FD}/reports/review-security.json`, FD));
});

test("holdout stays hidden from every reviewer lens", () => {
  assert.ok(checkRead({ role: "relay-reviewer", rel: `${FD}/holdout/scenarios.json` }));
});

test("laneProblem", () => {
  const r = (lane) => ({ agent: "relay-researcher", brief: "b", lane });
  assert.equal(laneProblem([r("a"), r("b")]), null);
  assert.ok(laneProblem([r("a"), r(undefined)]));
  assert.ok(laneProblem([r("a"), r("a")]));
  assert.ok(laneProblem([r("Bad Lane"), r("b")]));
  assert.ok(laneProblem([r("consolidated"), r("b")]));
  assert.ok(laneProblem([{ agent: "relay-implementor", brief: "b", lane: "x" }]));
  assert.equal(laneProblem([r(undefined)]), null);
});

test("reviewLenses defaults, config, UI and endpoint additions", () => {
  assert.deepEqual(reviewLenses({}, ["src/a.js"]), ["correctness", "security", "tests", "performance"]);
  assert.deepEqual(reviewLenses({ reviewLenses: ["security"] }, []), ["security"]);
  assert.ok(reviewLenses({}, ["web/App.tsx"]).includes("accessibility"));
  assert.ok(reviewLenses({}, ["src/routes/todos.js"]).includes("api-contract"));
  assert.ok(!reviewLenses({}, [".ai/f/page.html"]).includes("accessibility"));
});

test("mergeResearch requires conflicts and citations, merges topics", () => {
  const d = tmp();
  w(d, "research-api.md", "# api\nroute at src/a.js:10");
  w(d, "research-data.md", "# data\nmodel at src/db.js:3");
  assert.ok(!mergeResearch(d, FD, "").ok);
  const r = mergeResearch(d, FD, "none found");
  assert.ok(r.ok);
  const m = fs.readFileSync(path.join(d, FD, "research.md"), "utf8");
  assert.match(m, /## Topic: api/);
  assert.match(m, /## Topic: data/);
  assert.match(m, /## Conflicts and gaps/);
  assert.deepEqual(researchProblems(d, FD), []);
  w(d, "research-ui.md", "# ui\nno cites");
  assert.ok(!mergeResearch(d, FD, "x").ok);
  assert.ok(researchProblems(d, FD).length >= 1);
});

test("consolidateReview drops uncited, de-dups, ranks, flags blocking lenses", () => {
  const d = tmp();
  w(d, "reports/review-security.json", lens("security", [fnd("major", "src/a.js:5", "inj"), fnd("blocker", "src/nocite", "x")]));
  w(d, "reports/review-correctness.json", lens("correctness", [fnd("blocker", "src/a.js:5", "bug"), fnd("minor", "src/b.js:9")]));
  const r = consolidateReview(d, FD, schema);
  assert.ok(r.ok, r.error);
  assert.equal(r.dropped, 1);
  assert.equal(r.findings, 2);
  assert.equal(r.blocking, 1);
  assert.deepEqual(r.lensesWithBlocking, ["correctness", "security"]);
  assert.equal(r.verdict, "changes-requested");
  assert.match(fs.readFileSync(path.join(d, FD, "reports/review.md"), "utf8"), /Verdict: changes-requested/);
  assert.ok(reviewProblems(d, FD).some((p) => /blocking/.test(p)));
});

test("consolidateReview errors: lens mismatch, schema, missing expected lens", () => {
  const d = tmp();
  w(d, "reports/review-security.json", lens("tests", []));
  assert.ok(!consolidateReview(d, FD, schema).ok);
  w(d, "reports/review-security.json", lens("security", []));
  assert.ok(!consolidateReview(d, FD, schema, ["security", "tests"]).ok);
  const ok = consolidateReview(d, FD, schema, ["security"]);
  assert.ok(ok.ok);
  assert.equal(ok.verdict, "approve");
  assert.deepEqual(reviewProblems(d, FD), []);
});

test("reviewProblems: unconsolidated and stale", () => {
  const d = tmp();
  w(d, "reports/review-security.json", lens("security", []));
  assert.ok(reviewProblems(d, FD).some((p) => /not consolidated/.test(p)));
  consolidateReview(d, FD, schema);
  const f = path.join(d, FD, "reports/review-security.json");
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(f, future, future);
  assert.ok(reviewProblems(d, FD).some((p) => /newer/.test(p)));
});
