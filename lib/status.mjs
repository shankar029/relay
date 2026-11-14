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
      const status = j && LIVE.has(j.status) ? "running" : ss === "merged" ? "done" : ss === "failed" ? "failed" : ss === "running" ? (j?.status || "running") : "pending";
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
    slug: state.slug, phase, stages, children, running, pendingApproval,
    usage: { tokens: state.usage?.tokens || 0, calls: state.usage?.subagentCalls || 0 },
    questions: (state.pendingQuestions || []).length, now,
  };
}

const trunc = (s, w) => (w > 1 && s.length > w ? `${s.slice(0, w - 1)}…` : s);

/** Top bar: all stages, current one marked. Returns plain-text lines (no ANSI). */
export function renderTop(snap, width = 120) {
  const parts = snap.stages.map((s) => {
    const mark = s.status === "done" ? ICON.done : s.status === "current" ? ICON.current : ICON.pending;
    const gate = s.gate && s.status === "current" ? (s.approval === "pending" ? " ✋" : "") : "";
    return `${mark} ${s.label}${gate}`;
  });
  const head = `relay ${snap.slug}  phase=${snap.phase}  workers=${snap.running}  tokens=${fmtTok(snap.usage.tokens)}${snap.pendingApproval.length ? `  ✋ awaiting approval: ${snap.pendingApproval.join(",")}` : ""}${snap.questions ? `  ?${snap.questions} open question(s)` : ""}`;
  // Wrap the stage list to the available width.
  const lines = [trunc(head, width)];
  let cur = "";
  for (const p of parts) {
    if (cur && cur.length + p.length + 3 > width) { lines.push(cur); cur = p; } else cur = cur ? `${cur} › ${p}` : p;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Bottom panel: sub-steps of the current stage (slices, researcher lanes, review lenses...). */
export function renderBottom(snap, width = 120) {
  if (!snap.children.length) return [trunc(`stage ${snap.phase}: no workers`, width)];
  const lines = [trunc(`stage ${snap.phase} — ${snap.children.length} step(s)  (alt+w: watch workers)`, width)];
  for (const c of snap.children) {
    const j = c.job;
    const bits = [];
    if (j) {
      const end = j.endedAt || snap.now;
      if (j.startedAt) bits.push(fmtDur(end - j.startedAt));
      if (j.tools) bits.push(`${j.tools} tools`);
      if (j.tokens) bits.push(`${fmtTok(j.tokens)} tok`);
      if (j.attempt > 1) bits.push(`attempt ${j.attempt}`);
      if (c.status === "running" && j.last) bits.push(j.last);
    }
    if (c.extra) bits.push(c.extra);
    lines.push(trunc(`  ${ICON[c.status] || ICON.pending} ${c.label} [${c.status}]${bits.length ? "  " + bits.join(" · ") : ""}`, width));
  }
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
