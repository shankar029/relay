import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSnapshot, renderTop, renderBottom, applyEvent, reconcileJobs, upsertJob, readJobs, readLogLines, discoverFeatures } from "../lib/status.mjs";

const state = (phase, extra = {}) => ({ slug: "demo", phase, approvals: {}, slices: {}, usage: { tokens: 1500 }, pendingQuestions: [], ...extra });

test("top bar is a stepper: nodes joined by lines, labels beneath, detail for the current stage", () => {
  const snap = buildSnapshot({ state: state("spec-approval", { approvals: { spec: "pending" } }) });
  const [, nodes, labels, detail] = renderTop(snap, 200);
  assert.equal([...nodes].filter((c) => c === "✔").length, 4);
  assert.equal([...nodes].filter((c) => c === "●").length, 1);
  assert.equal([...nodes].filter((c) => c === "○").length, 8);
  assert.match(nodes, /✔─+●─+○/);
  assert.match(labels, /spec ok/);
  assert.match(detail, /Waiting for spec approval.*approval pending: spec/);
  assert.ok(!/\x1b/.test(renderTop(snap, 200).join("")));
  assert.match(renderTop(snap, 200, { color: true })[1], /\x1b\[32m/);
});

test("narrow terminals show a window around the current stage with scroll markers", () => {
  const snap = buildSnapshot({ state: state("implement") });
  const lines = renderTop(snap, 50);
  assert.ok(lines.every((l) => l.length <= 50));
  assert.match(lines[1], /^‹/);
  assert.match(lines[1], /›\s*$/);
  assert.match(lines[2], /implement/);
});
test("implement stage lists every plan slice with live job info", () => {
  const plan = { slices: [{ id: "api" }, { id: "ui" }, { id: "docs" }] };
  const jobs = [{ id: "1", agent: "relay-implementor", label: "implementor:api", phase: "implement", slice: "api", status: "running", startedAt: 0, tools: 4, tokens: 2000, last: "edit src/a.js" }];
  const st = state("implement", { slices: { api: { status: "running" }, ui: { status: "merged" }, docs: {} } });
  const snap = buildSnapshot({ state: st, plan, jobs, now: 5000 });
  assert.deepEqual(snap.children.map((c) => c.status), ["running", "done", "pending"]);
  const bottom = renderBottom(snap, 200).join("\n");
  assert.match(bottom, /Implement · 1\/3 done · 1 running/);
  assert.match(bottom, /● slice api\s+4 tools/);
  assert.match(bottom, /▸ edit src\/a\.js/);
  assert.match(bottom, /alt\+w/);
  assert.match(bottom, /✔ slice ui/);
});

test("review stage shows one row per lens (latest job wins)", () => {
  const jobs = ["correctness", "security"].map((l, i) => ({ id: String(i), agent: "relay-reviewer", label: `reviewer:${l}`, lane: l, phase: "review", status: i ? "done" : "running", startedAt: 0 }));
  const snap = buildSnapshot({ state: state("review"), jobs });
  assert.equal(snap.children.length, 2);
  assert.equal(snap.running, 1);
});

test("applyEvent counts tools, turns and tokens", () => {
  let j = { id: "x" };
  j = applyEvent(j, { type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
  j = applyEvent(j, { type: "message_end", message: { role: "assistant", usage: { input: 10, output: 5 }, content: [{ type: "text", text: "done" }] } });
  assert.equal(j.tools, 1); assert.equal(j.turns, 1); assert.equal(j.tokens, 15);
  assert.equal(j.last, "says: done");
});

test("jobs persist on disk and dead running workers become interrupted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-st-"));
  upsertJob(dir, { id: "a", status: "running", pid: 99999999, startedAt: 1 });
  upsertJob(dir, { id: "b", status: "done" });
  upsertJob(dir, { id: "a", tools: 3 });
  const jobs = readJobs(dir);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].tools, 3);
  const rec = reconcileJobs(jobs, () => false);
  assert.equal(rec[0].status, "interrupted");
  assert.equal(rec[1].status, "done");
  assert.equal(reconcileJobs(jobs, () => true)[0].status, "running");
  fs.rmSync(dir, { recursive: true });
});

test("log viewer formats events and ignores partial lines", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-log-")), "w.jsonl");
  fs.writeFileSync(f, [
    JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/a.js" } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello\nworld" }] } }),
    '{"type":"tool_exec',
  ].join("\n"));
  assert.deepEqual(readLogLines(f), ["▸ read src/a.js", "  hello", "  world"]);
  assert.deepEqual(readLogLines(path.join(os.tmpdir(), "nope.jsonl")), []);
});

test("discoverFeatures finds unfinished features newest first", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-disc-"));
  for (const [slug, phase, at] of [["a", "done", "2026-01-01"], ["b", "spec", "2026-02-01"]]) {
    fs.mkdirSync(path.join(root, ".ai", slug), { recursive: true });
    fs.writeFileSync(path.join(root, ".ai", slug, "state.json"), JSON.stringify({ slug, phase, updatedAt: at }));
  }
  const f = discoverFeatures([root]);
  assert.deepEqual(f.map((x) => x.slug), ["b", "a"]);
  fs.rmSync(root, { recursive: true });
});

test("bottom panel puts failures first and collapses extra rows", () => {
  const jobs = ["a", "b", "c", "d", "e"].map((l, i) => ({ id: String(i), agent: "relay-reviewer", label: `reviewer:${l}`, lane: l, phase: "review", status: l === "e" ? "failed" : i < 2 ? "done" : "running", startedAt: 0, last: "read x" }));
  const lines = renderBottom(buildSnapshot({ state: state("review"), jobs, now: 3000 }), 100, { maxRows: 3 });
  assert.match(lines[0], /2\/5 done · 2 running · 1 need attention/);
  assert.match(lines[1], /✖ reviewer:e/);
  assert.match(lines.join("\n"), /\+2 done/);
  assert.ok(lines.every((l) => l.length <= 100));
  assert.ok(!/\x1b/.test(lines.join("")));
});