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
