import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validate } from "./jsonschema.mjs";

export const PHASES = [
  "baseline", "requirement", "research", "spec", "spec-approval", "design",
  "design-review", "design-approval", "implement", "verify", "review", "pr", "done",
];

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Atomic write: temp file in same dir + rename.
export function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function newState({ slug, requirement, worktree }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, slug, requirement, ...(worktree ? { worktree } : {}), phase: "baseline",
    createdAt: now, updatedAt: now,
    steps: {}, counters: {}, approvals: {}, artifacts: {}, checks: {}, slices: {}, pendingQuestions: [],
  };
}

export function loadState(file, schema) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return { state: null, errors: [`unreadable: ${e.message}`] }; }
  const errors = validate(schema, raw);
  return errors.length ? { state: null, errors } : { state: raw, errors: [] };
}

export function saveState(file, state, schema) {
  state.updatedAt = new Date().toISOString();
  if (schema) {
    const errors = validate(schema, state);
    if (errors.length) throw new Error(`state.json would be invalid: ${errors.join("; ")}`);
  }
  writeFileAtomic(file, JSON.stringify(state, null, 2) + "\n");
}

// Write-ahead step helpers (mutate state; caller saves).
export function beginStep(state, id, { agent, inputs = [] } = {}) {
  state.steps[id] = { status: "running", agent, inputs, outputs: [], startedAt: new Date().toISOString() };
}

export function finishStep(state, id, { status = "done", outputs = [], error } = {}) {
  const s = state.steps[id];
  if (!s) throw new Error(`unknown step ${id}`);
  s.status = status;
  s.outputs = outputs;
  s.finishedAt = new Date().toISOString();
  if (error) s.error = error;
}

// Increment a loop counter; returns {count, cap, exceeded}.
export function bump(state, name, cap) {
  const c = state.counters[name] || { count: 0, cap: cap ?? 3 };
  if (cap !== undefined) c.cap = cap;
  c.count += 1;
  state.counters[name] = c;
  return { count: c.count, cap: c.cap, exceeded: c.count > c.cap };
}

// Compare recorded artefact hashes with disk. Returns mismatches.
export function verifyArtifacts(state, repoRoot) {
  const bad = [];
  for (const [name, a] of Object.entries(state.artifacts)) {
    const p = path.join(repoRoot, a.path);
    if (!fs.existsSync(p)) bad.push({ name, path: a.path, problem: "missing" });
    else if (sha256File(p) !== a.sha256) bad.push({ name, path: a.path, problem: "hash-changed" });
  }
  return bad;
}

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

export function lockStatus(lockFile, staleMs = 6 * 3600e3) {
  if (!fs.existsSync(lockFile)) return { held: false };
  try {
    const l = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    const age = Date.now() - Date.parse(l.timestamp);
    const stale = !pidAlive(l.pid) || age > staleMs;
    return { held: true, stale, pid: l.pid, timestamp: l.timestamp };
  } catch { return { held: true, stale: true, pid: null, timestamp: null }; }
}

// Acquire the lock. Held+fresh => refuse. Held+stale => refuse unless takeover=true (caller confirms with the user).
export function acquireLock(lockFile, { takeover = false } = {}) {
  const st = lockStatus(lockFile);
  if (st.held && !(st.stale && takeover) && st.pid !== process.pid) return { ok: false, ...st };
  writeFileAtomic(lockFile, JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }));
  return { ok: true };
}

export function releaseLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch { /* already gone */ }
}
