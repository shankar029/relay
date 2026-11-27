// Fresh-context document review for spec.md and design.md.
//
// Adapted from the Elephant-Goldfish Model (EGM), https://github.com/google/elephant-goldfish-model,
// Copyright Google LLC, licensed under Apache-2.0. MODIFIED for Relay: reviewer personas become lenses of one
// worker agent (relay-doc-reviewer, one pi process per lens), findings are JSON validated against a schema,
// consolidation/resolution/round caps are enforced in code, state lives on disk in .ai/<slug>/reports/.
// See NOTICE.
import fs from "node:fs";
import path from "node:path";
import { validate } from "./jsonschema.mjs";

export const DOCS = ["spec", "design"];
export const DOC_LENSES = {
  spec: ["zoom-out", "comprehension", "critic", "structural", "style"],
  design: ["zoom-out", "comprehension", "critic", "readiness", "codebase", "style"],
};
const RANK = { blocker: 3, major: 2, minor: 1 };
const BLOCKING = new Set(["blocker", "major"]);

/** Per-lens checklists (adapted from EGM's reviewer personas and document standards). */
export const DOC_LENS_CHECKLISTS = {
  "zoom-out": "Step back from the details. Does the document solve the stated problem, or a neighbouring easier one? Is a false compromise hiding a real contradiction between goals? Is anything in scope that need not be, or out of scope that the goal requires? Is there a simpler framing that makes a section unnecessary? If you find none, report nothing.",
  comprehension: "You have read nothing but the document. First write `paraphrase`: explain in your own words what is being built, for whom and why (spec) or how it works and why this shape (design), as a new team member would. Then report every place you could not follow: undefined terms, unstated actors, steps that assume knowledge the document never gives, ambiguous pronouns, sections that contradict each other. A gap a fresh reader hits is a document defect; never excuse it.",
  critic: "Stress-test as a hostile senior engineer. Faulty or unbacked assumptions about behaviour, performance, data or external systems; unmitigated risks (failure modes, scalability, security, data loss, migration/rollback, concurrency); missing answers to the obvious questions (who, what happens on error, how big, how fast, how do we know it works); decisions with no stated alternative or reason.",
  structural: "Structure and consistency: required sections present and in a sensible order, each section does one job, terms and names used consistently, no behaviour described in two places differently, every non-goal respected by the rest, every open question owned, scenarios/items traceable to behaviours. Spec only: it must describe WHAT, not HOW (flag implementation detail).",
  style: "Writing quality: plain direct English, no filler or promotional adjectives (seamless, robust), no unexplained jargon or acronyms, concrete over vague (numbers, names), active voice, short sections, no duplicated text. Style findings are minor unless they cause ambiguity.",
  readiness: "Could an engineer who has never seen this project build each slice from the document alone, without asking questions? Check: every slice has files, behaviours, contracts and tests stated; shared contracts are pinned with a concrete location; wave order and parallelism claims are justified; error handling, config, migrations and rollout are specified; no TODO/TBD/'as appropriate'. Name the exact question an implementor would have to ask.",
  codebase: "Ground the design in the code. Open the files, symbols, routes, tables and commands the design names and check they exist and behave as claimed; check the design reuses existing helpers instead of duplicating them, follows the repo's conventions (AGENTS.md) and does not break callers. Every finding cites the code as path:line in its rationale.",
};

export const laneInfo = (lane) => {
  const m = /^(spec|design)-([a-z0-9-]+)$/.exec(lane || "");
  return m && DOC_LENSES[m[1]].includes(m[2]) ? { doc: m[1], lens: m[2] } : null;
};
export const docReviewPath = (fd, lane) => `${fd}/reports/docreview-${lane}.json`;
export const docFiles = (doc) => (doc === "spec" ? ["spec.md", "features.json"] : ["design.md", "plan.json"]);

/** relay.config.json `docReview`: { enabled (default true), maxRounds (default 3), lenses: { spec: [...], design: [...] } }. */
export function docReviewConfig(config, doc) {
  const c = config?.docReview || {};
  const want = Array.isArray(c.lenses?.[doc]) ? c.lenses[doc].filter((l) => DOC_LENSES[doc].includes(l)) : [];
  return { enabled: c.enabled !== false, maxRounds: Number.isInteger(c.maxRounds) && c.maxRounds > 0 ? c.maxRounds : 3, lenses: want.length ? want : DOC_LENSES[doc] };
}

/** Error string for an invalid relay-doc-reviewer lane set in one parallel call, else null. */
export function docLaneProblem(tasks) {
  const ts = tasks.filter((t) => t.agent === "relay-doc-reviewer");
  if (!ts.length) return null;
  const lanes = ts.map((t) => t.lane);
  for (const l of lanes) if (!laneInfo(l)) return `relay-doc-reviewer: lane must be "<doc>-<lens>" with doc spec|design and a known lens (spec: ${DOC_LENSES.spec.join(", ")}; design: ${DOC_LENSES.design.join(", ")}); got "${l}"`;
  if (new Set(lanes).size !== lanes.length) return "relay-doc-reviewer: duplicate lanes";
  if (new Set(lanes.map((l) => laneInfo(l).doc)).size > 1) return "relay-doc-reviewer: review one document per call";
  return null;
}

const stateFile = (cwd, fd, doc) => path.join(cwd, fd, "reports", `docreview-${doc}-state.json`);
const consFile = (cwd, fd, doc) => path.join(cwd, fd, "reports", `docreview-${doc}-consolidated.json`);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const load = (cwd, fd, doc) => { try { return readJson(stateFile(cwd, fd, doc)); } catch { return { doc, status: "open", rounds: [], settled: [], fixed: [], decisions: {} }; } };
const save = (cwd, fd, doc, s) => { fs.mkdirSync(path.join(cwd, fd, "reports"), { recursive: true }); fs.writeFileSync(stateFile(cwd, fd, doc), JSON.stringify(s, null, 2)); };
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const keyOf = (f) => `${norm(f.scope)}|${norm(f.title)}`;
const STOP = new Set("a an the of to in on is are be as and or for with by no not has have its it this that does do from at".split(" "));
const stem = (w) => w.replace(/(ing|ed|es|s)$/, "");
const toks = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
const NONFINDING = /^\s*(no|none|nothing|zero)\b[^.:;]{0,50}\b(found|detected|identified|to report|to flag|issues?|problems?|concerns?|findings?|contradictions?|compromises?)\s*[.!]?\s*$|^\s*(looks good|all good|lgtm|well[- ]written|no action needed)\s*[.!]?\s*$/i;
const overlap = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i >= 2 ? i / Math.min(a.size, b.size) : 0; };
const jac = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
// Same issue reported by different lenses: near-identical title words, or similar title and overlapping scope.
const similar = (e, f) => { const t = jac(e.tt, toks(f.title)); return t >= 0.6 || overlap(e.tt, toks(f.title)) >= 0.75 || (t >= 0.34 && jac(e.st, toks(f.scope)) >= 0.34); };

/**
 * Consolidate reports/docreview-<doc>-<lens>.json of the current round: validate, drop findings without a scope,
 * de-duplicate (same scope + title), assign stable ids, mark reopened findings (one a fix was applied for in an
 * earlier round), write -consolidated.json and -report.md, record the round in the state file.
 * A lens report that is missing or invalid means that reviewer did not run: the round is not recorded.
 */
export function consolidateDocReview(cwd, fd, doc, lensSchema, { lenses, round, config } = {}) {
  const want = lenses || DOC_LENSES[doc];
  const rdir = path.join(cwd, fd, "reports");
  const errors = [], dropped = [], map = new Map(), paraphrases = {};
  for (const lens of want) {
    const n = `docreview-${doc}-${lens}.json`;
    let data;
    try { data = readJson(path.join(rdir, n)); } catch (e) { errors.push(`${n}: ${e.code === "ENOENT" ? "reviewer did not run (missing); re-run it, never count it as zero findings" : `unreadable: ${e.message}`}`); continue; }
    const errs = validate(lensSchema, data);
    if (errs.length) { errors.push(`${n} invalid: ${errs.slice(0, 3).join("; ")}`); continue; }
    if (data.doc !== doc || data.lens !== lens) { errors.push(`${n}: "doc" must be "${doc}" and "lens" "${lens}"`); continue; }
    if (lens === "comprehension") {
      if (!data.paraphrase || data.paraphrase.trim().length < 40) { errors.push(`${n}: comprehension needs a real "paraphrase" (at least 40 chars)`); continue; }
      paraphrases[lens] = data.paraphrase.trim();
    }
    for (let f of data.findings) {
      if (!f.scope.trim()) { dropped.push({ lens, title: f.title, reason: "no scope" }); continue; }
      if (NONFINDING.test(f.title)) { dropped.push({ lens, title: f.title, reason: "not a finding (reports no problem)" }); continue; }
      if (lens === "style" && f.severity !== "minor") f = { ...f, severity: "minor" };
      const key = keyOf(f);
      let e = map.get(key) || [...map.values()].find((x) => similar(x, f));
      if (!e) e = { key, keys: [], tt: toks(f.title), st: toks(f.scope), severity: "minor", lenses: [], scope: f.scope.trim(), title: f.title.trim(), rationale: [], recommendation: [] };
      if (!e.keys.includes(key)) e.keys.push(key);
      if (RANK[f.severity] > RANK[e.severity]) e.severity = f.severity;
      if (!e.lenses.includes(lens)) e.lenses.push(lens);
      e.rationale.push(f.rationale.trim()); e.recommendation.push(f.recommendation.trim());
      map.set(e.key, e);
    }
  }
  if (errors.length) return { ok: false, error: errors.join("; ") };
  const st = load(cwd, fd, doc);
  const r = round ?? st.rounds.length + 1;
  const findings = [...map.values()].sort((a, b) => RANK[b.severity] - RANK[a.severity]).map((e, i) => ({
    id: `${doc}-r${r}-${i + 1}`, severity: e.severity, lenses: e.lenses, scope: e.scope, title: e.title,
    rationale: [...new Set(e.rationale)].join(" "), recommendation: [...new Set(e.recommendation)].join(" "),
    key: e.key, keys: e.keys, settled: e.keys.some((k) => st.settled.includes(k)), reopened: e.keys.some((k) => st.fixed.includes(k)),
  }));
  const open = findings.filter((f) => BLOCKING.has(f.severity) && !f.settled);
  const clean = open.length === 0;
  const prior = st.rounds.length && st.rounds[st.rounds.length - 1].round === r ? st.rounds.slice(0, -1) : st.rounds;
  st.rounds = [...prior, { round: r, lenses: want, findings: findings.length, blocking: open.length, clean }];
  st.cleanStreak = clean ? (st.cleanStreak || 0) + 1 : 0;
  const need = 1;
  if (clean && st.cleanStreak >= need && st.status === "open") st.status = "converged";
  else if (!clean && st.status !== "accepted" && st.status !== "skipped") st.status = "open";
  save(cwd, fd, doc, st);
  const out = { doc, round: r, lenses: want, clean, status: st.status, findings, dropped, paraphrases, maxRounds: config?.maxRounds ?? 3 };
  fs.writeFileSync(consFile(cwd, fd, doc), JSON.stringify(out, null, 2));
  const md = [`# Document review: ${doc}, round ${r} (${want.join(", ")})`, "", ...Object.entries(paraphrases).map(([l, p]) => `## Fresh-reader paraphrase (${l})\n${p}\n`),
    ...findings.map((f) => `### ${f.id} [${f.severity}] ${f.title}${f.reopened ? " (REOPENED: a fix was applied earlier)" : ""}${f.settled ? " (settled)" : ""}\n- Lenses: ${f.lenses.join(", ")}\n- Scope: ${f.scope}\n- Problem: ${f.rationale}\n- Recommendation: ${f.recommendation}\n`),
    ...(findings.length ? [] : ["No findings.", ""]), ...(dropped.length ? [`Dropped (no scope): ${dropped.length}`, ""] : []), `Round ${r}: ${clean ? "clean (no unsettled blocker/major)" : `${open.length} unsettled blocker/major finding(s)`}`, ""].join("\n");
  fs.writeFileSync(path.join(rdir, `docreview-${doc}-report.md`), md);
  return { ok: true, round: r, clean, status: st.status, findings: findings.length, blocking: open.length, reopened: findings.filter((f) => f.reopened).length, dropped: dropped.length };
}

/** Counts the review round against the cap (counter docreview-<doc>); the first round is round 1. */
export function docReviewRound(state, doc, cap) {
  const c = state.counters[`docreview-${doc}`] || { count: 0, cap };
  c.cap = cap; c.count += 1; state.counters[`docreview-${doc}`] = c;
  if (c.count > cap) return { ok: false, error: `${doc} review round cap exceeded (${c.count - 1}/${cap}): list the open findings by severity and ask the user to accept (harness_state action=docreview_close status=accept), allow more rounds, or send the document back to drafting` };
  return { ok: true, round: c.count };
}

const ACTIONS = ["fix", "contest", "escalate", "decline"];
const headings = (md) => new Set([...md.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => norm(m[1])));

/**
 * Record the orchestrator's classification of every finding of the latest round.
 * fix: valid, will be repaired; contest: wrong, needs checkable evidence (existing path:line or an existing section
 * heading of the document), never for a finding only the comprehension lens raised; escalate: needs the user's
 * knowledge (not a fix); decline: minor only. Severity is never changed. Settled = contest/decline/escalate.
 */
export function resolveDocReview(cwd, fd, doc, decisions) {
  let cons;
  try { cons = readJson(consFile(cwd, fd, doc)); } catch { return { ok: false, error: "no consolidated review for this document (run docreview_consolidate)" }; }
  if (!Array.isArray(decisions)) return { ok: false, error: "decisions must be an array of {id, action, justification, evidence?}" };
  const docText = docFiles(doc).filter((n) => n.endsWith(".md")).map((n) => { try { return fs.readFileSync(path.join(cwd, fd, n), "utf8"); } catch { return ""; } }).join("\n");
  const hs = headings(docText);
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const errors = [];
  for (const f of cons.findings) {
    const d = byId.get(f.id);
    if (!d) { errors.push(`${f.id}: no decision`); continue; }
    if (!ACTIONS.includes(d.action)) { errors.push(`${f.id}: action must be one of ${ACTIONS.join("/")}`); continue; }
    if (!d.justification || !String(d.justification).trim()) errors.push(`${f.id}: justification required`);
    if (d.action === "decline" && f.severity !== "minor") errors.push(`${f.id}: only minor findings may be declined; severity is never lowered (contest with evidence instead)`);
    if (d.action === "contest") {
      if (f.lenses.every((l) => l === "comprehension")) errors.push(`${f.id}: a comprehension gap cannot be contested: the document is missing context (fix it)`);
      const ev = String(d.evidence || "").trim();
      const pm = /^(.+):(\d+)(?:-\d+)?$/.exec(ev);
      const ok = pm ? fs.existsSync(path.join(cwd, pm[1])) || fs.existsSync(path.join(cwd, "..", pm[1])) : ev && hs.has(norm(ev.replace(/^section:\s*/i, "")));
      if (!ok) errors.push(`${f.id}: a contest needs checkable evidence the reviewer could read: an existing "path:line" or "section: <heading in the document>"`);
    }
  }
  for (const id of byId.keys()) if (!cons.findings.some((f) => f.id === id)) errors.push(`${id}: unknown finding id`);
  if (errors.length) return { ok: false, error: errors.join("; ") };
  const st = load(cwd, fd, doc);
  for (const f of cons.findings) {
    const d = byId.get(f.id);
    const ks = f.keys || [f.key];
    if (d.action === "fix") { for (const k of ks) if (!st.fixed.includes(k)) st.fixed.push(k); st.settled = st.settled.filter((k) => !ks.includes(k)); }
    else for (const k of ks) if (!st.settled.includes(k)) st.settled.push(k);
  }
  st.decisions[`round-${cons.round}`] = decisions.map((d) => ({ id: d.id, action: d.action, justification: d.justification, evidence: d.evidence || null }));
  save(cwd, fd, doc, st);
  const count = (a) => decisions.filter((d) => d.action === a).length;
  return { ok: true, round: cons.round, fix: count("fix"), contest: count("contest"), escalate: count("escalate"), decline: count("decline"), escalated: cons.findings.filter((f) => byId.get(f.id).action === "escalate").map((f) => f.id), fixesToApply: cons.findings.filter((f) => byId.get(f.id).action === "fix").map((f) => f.id) };
}

/** Close the review without convergence: accept (open findings become accepted trade-offs) or skip, each with a reason. */
export function closeDocReview(cwd, fd, doc, status, reason) {
  if (!["accept", "skip"].includes(status)) return { ok: false, error: "status must be accept or skip" };
  if (!reason || !reason.trim()) return { ok: false, error: "a reason is required (recorded in the state file; also log it in decisions.md)" };
  const st = load(cwd, fd, doc);
  if (status === "accept" && !st.rounds.length) return { ok: false, error: "nothing to accept: no review round was recorded (use status=skip with a reason to skip the review)" };
  st.status = status === "accept" ? "accepted" : "skipped"; st.reason = reason.trim();
  save(cwd, fd, doc, st);
  return { ok: true, status: st.status };
}

/** Gate: the document review must have converged, been accepted at the cap, or been skipped with a reason. */
export function docReviewProblems(cwd, fd, doc, enabled = true) {
  if (!enabled) return [];
  const st = load(cwd, fd, doc);
  if (["converged", "accepted", "skipped"].includes(st.status)) return [];
  const last = st.rounds[st.rounds.length - 1];
  if (!last) return [`${doc} has not been through the fresh-context document review (harness_state docreview_lenses/docreview_consolidate; or docreview_close status=skip with a reason, or set relay.config.json docReview.enabled=false)`];
  return [`${doc} review is not converged: round ${last.round} left ${last.blocking} unsettled blocker/major finding(s); resolve them (docreview_resolve), revise the document, re-run the reviewers, or accept/skip with docreview_close`];
}
