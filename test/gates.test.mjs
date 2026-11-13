import test from "node:test";
import assert from "node:assert/strict";
import { checkWrite, requiredOutputs, phaseRequires, testGate } from "../lib/policy.mjs";

const fd = ".ai/x";

test("testGate requires test changes alongside code", () => {
  assert.equal(testGate(["src/app.js"]).length, 1);
  assert.deepEqual(testGate(["src/app.js", "test/app.test.js"]), []);
  assert.deepEqual(testGate(["README.md", ".ai/x/state.json"]), []);
});

test("requiredOutputs are canonical per role", () => {
  assert.deepEqual(requiredOutputs("relay-architect", fd), [`${fd}/design.md`, `${fd}/design.html`, `${fd}/plan.json`]);
  assert.deepEqual(requiredOutputs("relay-implementor", fd, "s1"), [`${fd}/reports/impl-s1.md`]);
  assert.deepEqual(requiredOutputs("relay-verifier", fd), []);
});

test("phaseRequires gates implement on plan.json", () => {
  assert.ok(phaseRequires("implement", fd).includes(`${fd}/plan.json`));
  assert.deepEqual(phaseRequires("baseline", fd), []);
});

test("README is writable by implementors only (when owned)", () => {
  const owned = ["README.md"];
  assert.equal(checkWrite({ role: "relay-implementor", rel: "README.md", featureDir: fd, owned }), null);
  assert.ok(checkWrite({ role: "relay-implementor", rel: "README.md", featureDir: fd, owned: ["src/**"] }));
  assert.ok(checkWrite({ role: "relay-spec-writer", rel: "README.md", featureDir: fd }));
  assert.ok(checkWrite({ role: "relay-implementor", rel: "AGENTS.md", featureDir: fd, owned: ["AGENTS.md"] }));
});

import { checkProblems, phaseProblems } from "../lib/gates.mjs";
test("checkProblems enforces required lint/sast/test: configured, run, green, not stale", () => {
  const req = ["lint", "sast", "test"];
  assert.equal(checkProblems({ checks: { test: "t" }, checkResults: { test: { ok: true, head: "a" } } }, req, "a").length, 2); // lint+sast not configured
  const st = { checks: { lint: "l", sast: "s", test: "t" }, checkResults: { lint: { ok: true, head: "a" }, sast: { ok: false, head: "a" } } };
  const p = checkProblems(st, req, "a").join("|");
  assert.match(p, /sast.*FAILED/); assert.match(p, /test.*not been run/);
  st.checkResults.sast.ok = true; st.checkResults.test = { ok: true, head: "old" };
  assert.match(checkProblems(st, req, "newhead").join("|"), /stale/);
  st.checkResults.test.head = "newhead"; st.checkResults.lint.head = st.checkResults.sast.head = "newhead";
  assert.deepEqual(checkProblems(st, req, "newhead"), []);
  assert.deepEqual(checkProblems({}, [], "x"), []);
});

import { autonomyLevel, requiredApprovals } from "../lib/autonomy.mjs";
test("autonomy levels select required approvals; pr approval enforced when supervised", () => {
  assert.equal(autonomyLevel({}), "gated");
  assert.equal(autonomyLevel({ autonomy: "bogus" }), "gated");
  assert.deepEqual(requiredApprovals({ autonomy: "supervised" }), ["spec", "design", "pr"]);
  assert.deepEqual(requiredApprovals({ autonomy: "autonomous" }), []);
});
test("phaseProblems honours requiredApprovals", () => {
  const base = { cwd: "/nonexistent", featureDir: ".ai/x", state: { approvals: {}, slices: {}, steps: {} }, schemas: {} };
  const has = (o, re) => phaseProblems({ ...base, ...o }).some((p) => re.test(p));
  assert.ok(has({ phase: "design" }, /spec has not been approved/));
  assert.ok(!has({ phase: "design", requiredApprovals: [] }, /not been approved/));
  assert.ok(!has({ phase: "done" }, /pr has not been approved/));
  assert.ok(has({ phase: "done", requiredApprovals: ["pr"] }, /pr has not been approved/));
});
import { recordLessons, loadLessons, lessonWarnings } from "../lib/speclessons.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
test("verifier failures become lessons that flag similar future scenarios", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "les-"));
  const res = { results: [{ scenario: "s1", result: "fail", evidence: [], symptom: "archived todos still appear in the default list" }, { scenario: "s2", result: "pass", evidence: ["e"] }] };
  assert.equal(recordLessons(cwd, res), true);
  assert.equal(recordLessons(cwd, res), false);
  const lessons = loadLessons(cwd);
  assert.equal(lessons.length, 1);
  const fe = { items: [{ name: "archive", scenarios: [{ name: "list", steps: ["GET /todos returns archived todos in the list"] }, { name: "other", steps: ["GET /health returns 200"] }] }] };
  const w = lessonWarnings(fe, lessons);
  assert.equal(w.length, 1);
  assert.match(w[0], /archive\/list/);
});
import { thirdPartyProblems } from "../lib/twins.mjs";
test("design gate requires twins/mocks for external services", () => {
  assert.deepEqual(thirdPartyProblems("add todo export", "{}", "# Design"), []);
  assert.equal(thirdPartyProblems("notify via Twilio sms", "{}", "# Design\nuse twilio").length, 1);
  assert.equal(thirdPartyProblems("send Slack message", "{}", "# Design\n## Third-party APIs\nSlack: call it directly").length, 1);
  assert.deepEqual(thirdPartyProblems("send Slack message", "{}", "# Design\n## Third-party APIs\nSlack: local fake server twin\n## Next"), []);
});
