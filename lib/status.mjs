import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./state.mjs";

// Pipeline stages in order. `gate` stages are human approvals.
export const STAGES = [
  { id: "baseline", label: "baseline" },
  { id: "requirement", label: "requirement" },
  { id: "research", label: "research" },
  { id: "spec", label: "spec" },
  { id: "spec-approval", label: "spec ok", gate: true },
  { id: "design", label: "design" },
  { id: "design-review", label: "design rev" },
  { id: "design-approval", label: "design ok", gate: true },
  { id: "implement", label: "implement" },
  { id: "verify", label: "verify" },
  { id: "review", label: "review" },
  { id: "pr", label: "pr" },
  { id: "done", label: "done" },
];

const ICON = { done: "✔", running: "●", pending: "○", failed: "✖", cancelled: "⊘", interrupted: "⚠", merged: "✔", current: "▶" };
const LIVE = new Set(["running"]);

/**
 * Runtime files (job registry + worker event logs) live in the worktree's private git dir,
 * so they are never tracked, committed, quarantined or reverted, yet survive restarts.
 */
export function runtimeDir(cwd, slug) {
  const gd = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return path.join(gd, "relay", slug);
}

export function readJobs(dir) {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8")); return Array.isArray(j) ? j : []; } catch { return []; }
}

export function writeJobs(dir, jobs) {
  writeFileAtomic(path.join(dir, "jobs.json"), JSON.stringify(jobs.slice(-80), null, 1));
}

export function upsertJob(dir, job) {
  const jobs = readJobs(dir);
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) jobs[i] = { ...jobs[i], ...job }; else jobs.push(job);
  writeJobs(dir, jobs);
  return jobs;
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** A job recorded as running whose worker process is gone is marked interrupted (e.g. after a crash/restart). */
export function reconcileJobs(jobs, alive = pidAlive) {
  return jobs.map((j) => (LIVE.has(j.status) && !alive(j.pid) ? { ...j, status: "interrupted", endedAt: j.endedAt || j.lastActivity || j.startedAt } : j));
}

/** Update a job's counters from one JSON event emitted by a worker pi process. */
export function applyEvent(job, ev, now = Date.now()) {
  const j = { ...job, lastActivity: now };
  if (ev.type === "tool_execution_start") {
    j.tools = (j.tools || 0) + 1;
    j.last = `${ev.toolName || "tool"} ${briefArgs(ev.args)}`.trim();
  } else if (ev.type === "message_end" && ev.message?.role === "assistant") {
    j.turns = (j.turns || 0) + 1;
    const u = ev.message.usage;
    if (u) j.tokens = (j.tokens || 0) + (u.totalTokens ?? ((u.input || 0) + (u.output || 0)));
    const t = (ev.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ").replace(/\s+/g, " ").trim();
    if (t) j.last = `says: ${t.slice(0, 80)}`;
  }
  return j;
}

function briefArgs(a) {
  if (!a || typeof a !== "object") return "";
  const v = a.path ?? a.command ?? a.pattern ?? Object.values(a)[0];
  return typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, 70) : "";
}

const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`; };
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0));

/** Find unfinished Relay features in a worktree list: [{slug, root}] newest first. */
export function discoverFeatures(roots) {
  const out = [];
  for (const root of roots) {
    const ai = path.join(root, ".ai");
    let names = [];
    try { names = fs.readdirSync(ai); } catch { continue; }
    for (const n of names) {
      const f = path.join(ai, n, "state.json");
      try {
        const st = JSON.parse(fs.readFileSync(f, "utf8"));
        out.push({ slug: st.slug || n, root, phase: st.phase, updatedAt: st.updatedAt || "" });
      } catch { /* not a feature dir */ }
    }
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

const stageStatus = (id, state) => {
  const cur = STAGES.findIndex((s) => s.id === state.phase);
  const idx = STAGES.findIndex((s) => s.id === id);
  if (idx < cur || state.phase === "done") return "done";
  return idx === cur ? "current" : "pending";
};

/** Pure: build the display model from state.json, plan.json (optional) and jobs.json. */
export function buildSnapshot({ state, plan = null, jobs = [], now = Date.now() }) {
  const stages = STAGES.map((s) => {
    let status = stageStatus(s.id, state);
    if (s.gate && status === "current") status = "current";
    const appr = s.id === "spec-approval" ? state.approvals?.spec : s.id === "design-approval" ? state.approvals?.design : undefined;
    return { ...s, status, approval: appr };
  });
  const phase = state.phase;
  const inPhase = jobs.filter((j) => j.phase === phase);
  const children = [];
  if (phase === "implement" && plan?.slices?.length) {
    for (const sl of plan.slices) {
      const j = [...inPhase].reverse().find((x) => x.slice === sl.id);
      const ss = state.slices?.[sl.id]?.status;
      const status = j && LIVE.has(j.status) ? "running" : ss === "merged" ? "done" : ss === "failed" ? "failed" : ss === "interrupted" ? "interrupted" : ss === "running" ? (j?.status || "running") : "pending";
      children.push({ label: `slice ${sl.id}`, status, job: j, extra: ss === "merged" ? "merged" : "" });
    }
  } else {
    const seen = new Map();
    for (const j of inPhase) seen.set(`${j.agent}:${j.lane || j.slice || ""}`, j);
    for (const j of seen.values()) children.push({ label: j.label, status: j.status, job: j });
  }
  // Workers still alive from an earlier phase are shown too.
  for (const j of jobs) if (j.phase !== phase && LIVE.has(j.status)) children.push({ label: `${j.label} (${j.phase})`, status: j.status, job: j });
  const running = jobs.filter((j) => LIVE.has(j.status)).length;
  const pendingApproval = Object.entries(state.approvals || {}).filter(([, v]) => v === "pending").map(([k]) => k);
  return {
    slug: state.slug, phase, stages, children, running, pendingApproval, paused: state.paused || null,
    phaseStartedAt: inPhase.length ? Math.min(...inPhase.map((j) => j.startedAt || now)) : 0,
    usage: { tokens: state.usage?.tokens || 0, calls: state.usage?.subagentCalls || 0 },
    questions: (state.pendingQuestions || []).length, now,
  };
}

const trunc = (s, w) => (w > 1 && s.length > w ? `${s.slice(0, w - 1)}…` : s);

const C = { green: "\x1b[32m", blue: "\x1b[1;34m", dim: "\x1b[2m", bold: "\x1b[1m", off: "\x1b[0m" };
const VERB = { baseline: "Checking the baseline", requirement: "Capturing the requirement", research: "Researching", spec: "Writing the spec", "spec-approval": "Waiting for spec approval", design: "Designing", "design-review": "Reviewing the design", "design-approval": "Waiting for design approval", implement: "Implementing", verify: "Verifying", review: "Reviewing", pr: "Preparing the PR", done: "Done" };
const center = (s, w) => { const l = Math.max(0, Math.floor((w - s.length) / 2)); return " ".repeat(l) + s + " ".repeat(Math.max(0, w - s.length - l)); };

/** Short status line for the current stage, e.g. "Implementing 2/4 slices · 03:12". */
export function stageDetail(snap) {
  const bits = [VERB[snap.phase] || snap.phase];
  const total = snap.children.length;
  const done = snap.children.filter((c) => c.status === "done").length;
  if (total && snap.phase === "implement") bits[0] += ` ${done}/${total} slices`;
  else if (total) bits[0] += ` ${done}/${total} workers`;
  if (snap.phaseStartedAt) { const s = Math.max(0, Math.round((snap.now - snap.phaseStartedAt) / 1000)); bits.push(`${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`); }
  if (snap.paused) bits.unshift("⏸ PAUSED");
  if (snap.pendingApproval.length) bits.push(`✋ approval pending: ${snap.pendingApproval.join(",")}`);
  return bits.join(" · ");
}

/**
 * Top bar: a horizontal stepper (node per stage joined by lines, label underneath, detail line under the current stage).
 * Scrolls a window around the current stage on narrow terminals. `color` adds ANSI; the plain form stays readable.
 */
export function renderTop(snap, width = 120, { color = false } = {}) {
  const paint = (c, s) => (color ? `${c}${s}${C.off}` : s);
  const head = `relay ${snap.slug}  phase=${snap.phase}  workers=${snap.running}${snap.paused ? "  ⏸ PAUSED" : ""}  tokens=${fmtTok(snap.usage.tokens)}${snap.questions ? `  ?${snap.questions} open question(s)` : ""}`;
  const st = snap.stages;
  const maxLabel = Math.max(...st.map((s) => s.label.length));
  const cw = Math.max(maxLabel + 2, 8);
  const fit = Math.max(3, Math.floor(width / cw));
  const n = Math.min(st.length, fit);
  const cur = Math.max(0, st.findIndex((s) => s.status === "current"));
  let start = Math.min(Math.max(0, cur - Math.floor(n / 2)), st.length - n);
  const vis = st.slice(start, start + n);
  const nodeLine = [], labelLine = [];
  vis.forEach((s, i) => {
    const glyph = s.status === "done" ? "✔" : s.status === "current" ? "●" : "○";
    const gc = s.status === "done" ? C.green : s.status === "current" ? C.blue : C.dim;
    const half = Math.floor((cw - 1) / 2), rest = cw - 1 - half;
    const leftDone = s.status !== "pending";
    const rightDone = s.status === "done";
    const seg = (len, on) => paint(on ? C.green : C.dim, "─".repeat(len));
    nodeLine.push((i === 0 && start > 0 ? paint(C.dim, "‹".padEnd(half, " ")) : i === 0 ? " ".repeat(half) : seg(half, leftDone)) + paint(gc, glyph) + (i === vis.length - 1 ? (start + n < st.length ? paint(C.dim, "›".padStart(rest, " ")) : " ".repeat(rest)) : seg(rest, rightDone)));
    const lab = trunc(s.label, cw - 1);
    labelLine.push(paint(s.status === "current" ? C.bold : s.status === "pending" ? C.dim : "", center(lab, cw)));
  });
  const lines = [trunc(head, width), nodeLine.join(""), labelLine.join("")];
  lines.push(paint(C.blue, trunc(" ▸ " + stageDetail(snap), width)));
  return lines;
}
const TITLE = { baseline: "Baseline", requirement: "Requirement", research: "Research", spec: "Spec", "spec-approval": "Spec approval", design: "Design", "design-review": "Design review", "design-approval": "Design approval", implement: "Implement", verify: "Verify", review: "Review", pr: "PR", done: "Done" };
const GLYPH = { done: "✔", running: "●", pending: "○", failed: "✖", cancelled: "⊘", interrupted: "⚠" };
const ORDER = { failed: 0, interrupted: 0, running: 1, pending: 2, cancelled: 3, done: 4 };

/**
 * Bottom panel: workers of the current stage, one row each (glyph, name, time, tools, tokens, then a "now doing" line
 * for running workers). Failures first, then running, pending, done. Capped at `maxRows`; the rest collapses to "+N done".
 */
export function renderBottom(snap, width = 120, { color = false, maxRows = 8 } = {}) {
  const paint = (c, s) => (color ? `${c}${s}${C.off}` : s);
  const kids = snap.children;
  const title = TITLE[snap.phase] || snap.phase;
  if (!kids.length) return [paint(C.dim, trunc(` ${title} · no workers running   alt+w watch`, width))];
  const done = kids.filter((c) => c.status === "done").length;
  const running = kids.filter((c) => c.status === "running").length;
  const bad = kids.filter((c) => ["failed", "interrupted"].includes(c.status)).length;
  const barLen = Math.min(10, kids.length * 2);
  const filled = Math.round((done / kids.length) * barLen);
  const bar = paint(C.green, "█".repeat(filled)) + paint(C.dim, "░".repeat(barLen - filled));
  const headTxt = `${title} · ${done}/${kids.length} done${running ? ` · ${running} running` : ""}${bad ? ` · ${bad} need attention` : ""}`;
  const lines = [` ${bar} ${paint(bad ? "\x1b[1;31m" : C.bold, trunc(headTxt, Math.max(10, width - barLen - 3)))}`];
  const sorted = [...kids].sort((x, y) => (ORDER[x.status] ?? 2) - (ORDER[y.status] ?? 2));
  const nameW = Math.min(28, Math.max(...kids.map((c) => c.label.length)));
  let shown = 0, hidden = { done: 0, pending: 0 };
  for (const c of sorted) {
    if (shown >= maxRows) { if (c.status === "done") hidden.done++; else hidden.pending++; continue; }
    shown++;
    const j = c.job;
    const bits = [];
    if (j?.startedAt) bits.push(fmtDur((j.endedAt || snap.now) - j.startedAt));
    if (j?.tools) bits.push(`${j.tools} tools`);
    if (j?.tokens) bits.push(`${fmtTok(j.tokens)} tok`);
    if (j?.attempt > 1) bits.push(`attempt ${j.attempt}`);
    if (c.extra) bits.push(c.extra);
    const gc = c.status === "done" ? C.green : c.status === "running" ? C.blue : ["failed", "interrupted"].includes(c.status) ? "\x1b[1;31m" : C.dim;
    const row = `  ${paint(gc, GLYPH[c.status] || "○")} ${c.label.padEnd(nameW)}  ${paint(c.status === "pending" ? C.dim : "", bits.join(" · ") || c.status)}`;
    lines.push(trunc(row, color ? width + 20 : width));
    if (c.status === "running" && j?.last) lines.push(paint(C.dim, trunc(`      ▸ ${j.last}`, width)));
  }
  const rest = [hidden.done ? `+${hidden.done} done` : "", hidden.pending ? `+${hidden.pending} more` : ""].filter(Boolean).join(", ");
  if (rest) lines.push(paint(C.dim, `    ${rest}`));
  lines.push(paint(C.dim, trunc("  alt+w watch a worker · /relay-watch <name> · ask me anything while they run", width)));
  return lines;
}
/** Turn one worker JSON event into display lines for the live viewer. */
export function formatEvent(ev) {
  if (ev.type === "relay_marker") return [`── ${ev.text} ──`];
  if (ev.type === "tool_execution_start") return [`▸ ${ev.toolName || "tool"} ${briefArgs(ev.args)}`];
  if (ev.type === "tool_execution_end") return ev.isError ? [`  ✖ ${ev.toolName || "tool"} failed`] : [];
  if (ev.type === "message_end" && ev.message?.role === "assistant") {
    const t = (ev.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    const out = t ? t.split(/\r?\n/).map((l) => `  ${l}`) : [];
    if (ev.message.errorMessage) out.push(`  ✖ ${ev.message.errorMessage}`);
    return out;
  }
  return [];
}

/** Read the last `maxBytes` of a JSONL log and format it. Safe against partial/garbage lines. */
export function readLogLines(file, maxBytes = 200_000) {
  let buf;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const lines = [];
  for (const l of buf.toString("utf8").split("\n")) {
    if (!l.trim()) continue;
    try { lines.push(...formatEvent(JSON.parse(l))); } catch { /* partial line */ }
  }
  return lines;
}
