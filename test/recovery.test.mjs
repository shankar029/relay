import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { newState, beginStep, markInterrupted, pauseState, acquireLock, saveState, loadState } from "../lib/state.mjs";
import { buildSnapshot, renderTop } from "../lib/status.mjs";

const schema = JSON.parse(fs.readFileSync(new URL("../schemas/state.schema.json", import.meta.url), "utf8"));

test("markInterrupted flips running steps/slices, keeps counters and done work", () => {
  const st = newState({ slug: "x", requirement: "r" });
  beginStep(st, "impl-a", { agent: "relay-implementor" });
  st.steps.done1 = { status: "done" };
  st.slices.a = { status: "running" }; st.slices.b = { status: "merged", commit: "abc" };
  st.counters.loop = { count: 2, cap: 3 };
  const inFlight = markInterrupted(st);
  assert.deepEqual([...inFlight].sort(), ["slice:a", "step:impl-a"]);
  assert.equal(st.steps["impl-a"].status, "interrupted");
  assert.equal(st.steps.done1.status, "done");
  assert.equal(st.slices.b.status, "merged");
  assert.equal(st.counters.loop.count, 2);
  pauseState(st, { inFlight });
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rl-")), "state.json");
  saveState(f, st, schema);
  assert.equal(loadState(f, schema).state.paused.inFlight.length, 2);
});

test("a lock owned by a dead pid is taken over without confirmation", () => {
  const lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rl-")), ".lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483000, timestamp: new Date().toISOString() }));
  assert.equal(acquireLock(lock).ok, true);
});

test("a live foreign lock is still refused", (t) => {
  const other = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"]);
  t.after(() => other.kill());
  const lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rl-")), ".lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: other.pid, timestamp: new Date().toISOString() }));
  assert.equal(acquireLock(lock).ok, false);
});

test("status shows PAUSED and interrupted slices", () => {
  const st = newState({ slug: "x", requirement: "r" });
  st.phase = "implement"; st.slices.a = { status: "interrupted" };
  pauseState(st, { inFlight: ["slice:a"] });
  const plan = { slices: [{ id: "a" }] };
  const snap = buildSnapshot({ state: st, plan, jobs: [] });
  assert.equal(snap.children[0].status, "interrupted");
  assert.match(renderTop(snap, 120).join("\n"), /PAUSED/);
});
