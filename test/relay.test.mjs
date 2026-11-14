import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validate } from "../lib/jsonschema.mjs";
import { parseFrontmatter } from "../lib/frontmatter.mjs";
import { checkWrite, matchesAny } from "../lib/policy.mjs";
import { checkPlan, globsOverlap } from "../lib/plan.mjs";
import * as S from "../lib/state.mjs";
import { addLesson, lessonsFor, LESSON_CAP, parseLessons } from "../lib/lessons.mjs";
import { scanText, maskText } from "../lib/secrets.mjs";

const root = path.resolve(import.meta.dirname, "..");
const stateSchema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "state.schema.json"), "utf8"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "relay-"));
const plan = () => JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", "plan.sample.json"), "utf8"));

test("jsonschema rejects bad values", () => {
  assert.ok(validate({ type: "object", required: ["a"] }, {}).length > 0);
  assert.deepEqual(validate({ type: "string", pattern: "^a" }, "abc"), []);
  assert.ok(validate({ enum: [1, 2] }, 3).length > 0);
});

test("frontmatter parses", () => {
  const { data, body } = parseFrontmatter("---\nname: x\ndescription: hi there\n---\nbody");
  assert.equal(data.name, "x");
  assert.equal(data.description, "hi there");
  assert.equal(body.trim(), "body");
});

test("policy: role write rules", () => {
  const fd = ".ai/f";
  assert.equal(checkWrite({ role: "relay-researcher", rel: ".ai/f/research.md", featureDir: fd }), null);
  assert.ok(checkWrite({ role: "relay-researcher", rel: "src/a.ts", featureDir: fd }));
  assert.ok(checkWrite({ role: "relay", rel: "src/a.ts", featureDir: fd }));
  assert.ok(checkWrite({ role: "relay", rel: ".ai/f/state.json", featureDir: fd }));
  assert.ok(checkWrite({ role: "relay-implementor", rel: "AGENTS.md", featureDir: fd, owned: ["**"] }));
  assert.equal(checkWrite({ role: "relay-implementor", rel: "src/api/x.ts", featureDir: fd, owned: ["src/api/**"] }), null);
  assert.ok(checkWrite({ role: "relay-implementor", rel: "src/ui/x.ts", featureDir: fd, owned: ["src/api/**"] }));
  assert.ok(checkWrite({ role: "relay-verifier", rel: "src/a.ts", featureDir: fd }));
  assert.equal(checkWrite({ role: "relay-verifier", rel: ".ai/f/evidence/a.png", featureDir: fd }), null);
  assert.ok(checkWrite({ role: "relay-implementor", rel: "../x", featureDir: fd, owned: ["**"] }));
  assert.ok(matchesAny(["src/**"], "src/a/b.ts"));
});

test("plan: sample is valid; overlap and bad deps are caught", () => {
  assert.deepEqual(checkPlan(plan()), []);
  assert.ok(globsOverlap("src/**", "src/api/**"));
  assert.ok(!globsOverlap("src/api/**", "src/ui/**"));
  const p = plan();
  p.slices[1].files.own = ["src/api/x.ts"];
  assert.ok(checkPlan(p).some((e) => e.includes("overlap")));
  const nt = plan(); nt.slices[0].features = ["f1"]; nt.slices[0].tests = [];
  assert.ok(checkPlan(nt).some((e) => e.includes("no tests")));
  const q = plan();
  q.independence.parallelizable = false;
  assert.ok(checkPlan(q).length > 0);
  const r = plan();
  r.slices[1].dependsOn = ["api-endpoint"];
  assert.ok(checkPlan(r).some((e) => e.includes("earlier wave")));
  const u = plan();
  u.slices[0].contracts = ["Unpinned"];
  assert.ok(checkPlan(u).some((e) => e.includes("not pinned")));
});

test("state: atomic save, load, corrupt detection, steps, counters", () => {
  const dir = tmp();
  const file = path.join(dir, "state.json");
  const st = S.newState({ slug: "demo", requirement: "r" });
  S.beginStep(st, "research", { agent: "relay-researcher", inputs: ["a"] });
  assert.equal(st.steps.research.status, "running");
  S.finishStep(st, "research", { status: "done" });
  S.saveState(file, st, stateSchema);
  assert.equal(S.loadState(file, stateSchema).state.slug, "demo");
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
  fs.writeFileSync(file, "{not json");
  assert.equal(S.loadState(file, stateSchema).state, null);
  assert.equal(S.bump(st, "x", 2).exceeded, false);
  S.bump(st, "x");
  assert.equal(S.bump(st, "x").exceeded, true);
  assert.throws(() => S.saveState(file, { ...st, phase: "bogus" }, stateSchema));
});

test("state: artifact hashes detect drift", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "a.md"), "one");
  const st = S.newState({ slug: "demo", requirement: "r" });
  st.artifacts.a = { path: "a.md", sha256: S.sha256File(path.join(dir, "a.md")) };
  assert.equal(S.verifyArtifacts(st, dir).length, 0);
  fs.writeFileSync(path.join(dir, "a.md"), "two");
  assert.equal(S.verifyArtifacts(st, dir).length, 1);
});

test("state: lock refuses fresh holder, stale takeover needs confirmation", (t) => {
  const dir = tmp();
  const lock = path.join(dir, ".lock");
  const other = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"]);
  t.after(() => other.kill());
  assert.ok(S.acquireLock(lock).ok);
  fs.writeFileSync(lock, JSON.stringify({ pid: other.pid, timestamp: new Date(Date.now() - 7 * 3600e3).toISOString() }));
  const st = S.lockStatus(lock);
  assert.ok(st.held && st.stale);
  assert.equal(S.acquireLock(lock).ok, false);
  assert.equal(S.acquireLock(lock, { takeover: true }).ok, true);
  S.releaseLock(lock);
  assert.equal(S.lockStatus(lock).held, false);
});

test("lessons: role filter, cap, dedupe", () => {
  let text = "# Lessons\n";
  text = addLesson(text, { date: "2026-01-01", role: "relay-implementor", symptom: "s", rule: "r" });
  text = addLesson(text, { date: "2026-01-01", role: "relay-implementor", symptom: "s", rule: "r" });
  text = addLesson(text, { date: "2026-01-01", role: "relay-verifier", symptom: "s2", rule: "r2" });
  assert.equal(parseLessons(text).length, 2);
  assert.equal(lessonsFor(text, "relay-verifier").length, 1);
  for (let i = 0; i < 40; i++) text = addLesson(text, { date: "2026-01-02", role: "relay-reviewer", symptom: `s${i}`, rule: `r${i}` });
  assert.equal(parseLessons(text).length, LESSON_CAP);
});

test("secrets: detect and mask", () => {
  const fake = "ghp_" + "a".repeat(36);
  assert.ok(scanText(`token=${fake}`).length > 0);
  assert.ok(!maskText(`token=${fake}`).includes(fake));
  assert.equal(scanText("nothing here").length, 0);
});
