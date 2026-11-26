import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
// @ts-ignore plain ESM helpers (see lib/)
import { validate } from "../../lib/jsonschema.mjs";
// @ts-ignore
import { checkWrite, bashConfinementProblem, checkRead, matchesAny, requiredOutputs, phaseRequires, testGate } from "../../lib/policy.mjs";
// @ts-ignore
import * as S_ from "../../lib/state.mjs";
// @ts-ignore
import { checkPlan } from "../../lib/plan.mjs";
import * as WS from "../../lib/workspace.mjs";
import { readMarker } from "../../lib/workspace.mjs";
// @ts-ignore
import { lessonsFor, addLesson } from "../../lib/lessons.mjs";
// @ts-ignore
import { scanText, maskText } from "../../lib/secrets.mjs";
// @ts-ignore
import { ensureWorktree, findWorktree, excludeHarnessFiles, branchFor, repoTop } from "../../lib/worktree.mjs";
// @ts-ignore
import { phaseProblems, renderPr } from "../../lib/gates.mjs";
// @ts-ignore
import { holdoutAccessProblem, holdoutResultProblems } from "../../lib/holdout.mjs";
// @ts-ignore
import { loadLessons, recordLessons } from "../../lib/speclessons.mjs";
import { autonomyLevel, requiredApprovals } from "../../lib/autonomy.mjs";
import { addUsage, budgetProblem } from "../../lib/budget.mjs";
import * as DR from "../../lib/docreview.mjs";
import { laneProblem, reviewLenses, mergeResearch, consolidateReview, reviewRerun, reviewChangedFiles, LENS_CHECKLISTS } from "../../lib/fanout.mjs";
// @ts-ignore
import { stashPartialWork, enforceOwnership, quarantineStrays, commitArtefacts, addSliceWorktree, commitSliceLeftovers, mergeSlices, removeSliceWorktree, changedSince } from "../../lib/gitflow.mjs";
const S: any = S_;
import { RELAY_HOME, loadAgents, runAgent, mapLimit } from "./run.ts";
import { WatchView } from "./watch.ts";
// @ts-ignore plain ESM helper
import * as I_ from "../../lib/init.mjs";
import * as WI from "../../lib/wsinit.mjs";
// @ts-ignore plain ESM helper
import * as PR from "../../lib/prs.mjs";
const I: any = I_;
// @ts-ignore plain ESM helper
import { runtimeDir, readJobs, writeJobs, upsertJob, reconcileJobs, applyEvent, buildSnapshot, renderTop, renderBottom, discoverFeatures, readLogLines } from "../../lib/status.mjs";
// @ts-ignore plain ESM helper
import { listWorktrees } from "../../lib/worktree.mjs";

function defaultBranch(cwd: string): string {
  try { return git(cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"); } catch { /* no remote */ }
  try {
    const top = git(cwd, "worktree", "list", "--porcelain").split("\n").find((l) => l.startsWith("branch "));
    if (top) return top.replace("branch refs/heads/", "").trim();
  } catch { /* none */ }
  return "main";
}

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const schema = (n: string) => readJson(path.join(RELAY_HOME, "schemas", `${n}.schema.json`));
const text = (t: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text: t }], details });
const posix = (p: string) => p.split(path.sep).join("/");
const gateSchemas = () => ({ features: schema("features"), plan: schema("plan"), holdout: schema("holdout"), holdoutResults: schema("holdout-results") });
// relay.config.json "satisfactionThreshold" (0..1): minimum holdout pass fraction to enter review. Default 1 (all must pass).
const cfgBases = (cwd: string): string[] => { const m = readMarker(cwd); return m?.root ? [cwd, m.root, RELAY_HOME] : [cwd, RELAY_HOME]; };
const satThreshold = (cwd: string): number => {
  for (const base of cfgBases(cwd)) {
    const f = path.join(base, "relay.config.json");
    if (fs.existsSync(f)) { try { const v = readJson(f).satisfactionThreshold; return typeof v === "number" ? v : 1; } catch { return 1; } }
  }
  return 1;
};

// relay.config.json "requiredChecks": checks that must have run green on the current HEAD before review (default: test).
const requiredChecks = (cwd: string): string[] => {
  for (const base of cfgBases(cwd)) {
    const f = path.join(base, "relay.config.json");
    if (fs.existsSync(f)) { try { const v = readJson(f).requiredChecks; return Array.isArray(v) ? v.map(String) : ["test"]; } catch { return ["test"]; } }
  }
  return ["test"];
};
const headOf = (cwd: string): string | null => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(); } catch { return null; } };

const budgetOf = (cwd: string): any => {
  for (const base of cfgBases(cwd)) {
    const f = path.join(base, "relay.config.json");
    if (fs.existsSync(f)) { try { return readJson(f).budget || {}; } catch { return {}; } }
  }
  return {};
};

const configOf = (cwd: string): any => {
  for (const base of cfgBases(cwd)) {
    const f = path.join(base, "relay.config.json");
    if (fs.existsSync(f)) { try { return readJson(f); } catch { return {}; } }
  }
  return {};
};

// Required checks + staleness: per repo (keys "<repo>:<check>", each against its own HEAD) in workspace features.
const checkGate = (cwd: string, st: any) => {
  const repos = Object.keys(st.workspace?.repos || {});
  if (!repos.length) return { required: requiredChecks(cwd), head: headOf(cwd), extra: [] as string[] };
  return { required: WS.requiredWorkspaceChecks(repos, requiredChecks(cwd)), head: null, extra: WS.checkStaleness(cwd, st, repos, requiredChecks(cwd)) as string[] };
};

const IS_CHILD = process.env.RELAY_CHILD === "1";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

export default function (pi: ExtensionAPI) {
  let slug: string | undefined = IS_CHILD ? process.env.RELAY_FEATURE : undefined;
  const role = IS_CHILD ? process.env.RELAY_ROLE || "unknown" : "relay";
  const owned: string[] = IS_CHILD && process.env.RELAY_OWNED ? JSON.parse(process.env.RELAY_OWNED) : [];

  // Feature worktree (parent only). Children always run with cwd = the worktree.
  let root: string | undefined;
  const rootOf = (ctx: any): string => root ?? ctx.cwd ?? process.cwd();
  const featureDir = () => `.ai/${slug}`;
  const stateFile = (cwd: string) => path.join(cwd, featureDir(), "state.json");
  const withState = (cwd: string, fn: (st: any) => unknown) => {
    const { state, errors } = S.loadState(stateFile(cwd), schema("state"));
    if (!state) throw new Error(`state.json invalid: ${errors.join("; ")}`);
    const r = fn(state);
    S.saveState(stateFile(cwd), state, schema("state"));
    return r;
  };

  // ---- Enforcement: tool_call guard (parent: once a feature is active; children: always) ----
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!slug) return undefined;
    const input = event.input || {};
    const cwd = rootOf(ctx);
    if (event.toolName === "write" || event.toolName === "edit") {
      const rel = posix(path.relative(cwd, path.resolve(cwd, String(input.path || ""))));
      const why = (checkWrite as any)({ role, rel, featureDir: featureDir(), owned });
      if (why) return { block: true, reason: `relay guard (${role}): cannot write ${rel}: ${why}` };
    }
    if (event.toolName === "read") {
      const why = (checkRead as any)({ role, rel: posix(String(input.path || "")) });
      if (why) return { block: true, reason: `relay guard: ${why}` };
    }
    if (["bash", "grep", "find", "ls"].includes(event.toolName)) {
      const why = (holdoutAccessProblem as any)(role, JSON.stringify(input));
      if (why) return { block: true, reason: `relay guard: ${why}` };
    }
    if (event.toolName === "bash") {
      const cmd = String(input.command || "");
      const esc = (bashConfinementProblem as any)(cmd, cwd);
      if (esc) return { block: true, reason: `relay guard: bash write confinement: ${esc}` };
      if (/\bgit\s+push\b/.test(cmd)) return { block: true, reason: "relay guard: git push is not allowed" };
      if (/\bgit\s+commit\b/.test(cmd) && role !== "relay-implementor") {
        return { block: true, reason: `relay guard: ${role} may not commit` };
      }
    }
    return undefined;
  });

  if (IS_CHILD) {
    if (role === "relay-verifier") registerSetPasses();
    return; // workers get no orchestration tools, so they cannot spawn sub-agents
  }

  // ---- Verifier-only tool ----
  function registerSetPasses() {
    pi.registerTool({
      name: "relay_set_passes",
      label: "Set passes",
      description: "Record a scenario result in features.json. passes=true requires existing, non-empty evidence files under the feature's evidence/ dir.",
      parameters: Type.Object({
        item: Type.String({ description: "features.json item name" }),
        scenario: Type.String({ description: "scenario name" }),
        passes: Type.Boolean(),
        evidence: Type.Optional(Type.Array(Type.String(), { description: "evidence paths relative to the repo root" })),
      }),
      async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
        const cwd = ctx.cwd || process.cwd();
        const file = path.join(cwd, featureDir(), "features.json");
        const data = readJson(file);
        const item = data.items.find((i: any) => i.name === p.item);
        const sc = item?.scenarios.find((s: any) => s.name === p.scenario);
        if (!sc) return text(`error: unknown item/scenario ${p.item}/${p.scenario}`);
        const evidence: string[] = p.evidence || [];
        if (p.passes) {
          const evDir = `${featureDir()}/evidence/`;
          const bad = evidence.filter((e) => {
            const rel = posix(e);
            const abs = path.join(cwd, rel);
            return !rel.startsWith(evDir) || !fs.existsSync(abs) || fs.statSync(abs).size === 0;
          });
          if (!evidence.length || bad.length) {
            return text(`refused: passes=true needs existing non-empty files under ${evDir}. ${bad.length ? `Bad: ${bad.join(", ")}` : "No evidence given."}`);
          }
        }
        sc.passes = !!p.passes;
        sc.evidence = evidence;
        item.passes = item.scenarios.every((s: any) => s.passes);
        const errs = validate(schema("features"), data);
        if (errs.length) return text(`refused: features.json would be invalid: ${errs.join("; ")}`);
        S.writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
        return text(`${p.item}/${p.scenario} passes=${sc.passes}; item passes=${item.passes}`);
      },
    });
  }

  // ---- Orchestrator tools ----
  pi.registerTool({
    name: "harness_state",
    label: "Harness state",
    description:
      "Read/modify .ai/<slug>/state.json safely (atomic, schema-validated). Actions: init, open, get, set_phase (content-gated; 'done' is refused), pr_draft (text=summary, name=title, symptom=caveats one per line; writes pr.md), finalize (phase pr -> secret scan, commit .ai/<slug>, done; does not push: use relay_pr after it), step, counter, approval (only 'pending'), slice, checks, question, answer, artifact, lesson_add, lessons_for, unlock, docreview_lenses (name=spec|design: lanes for relay-doc-reviewer), docreview_consolidate (name=doc; counts a round, cap docReview.maxRounds), docreview_resolve (name=doc, text=JSON [{id,action:fix|contest|escalate|decline,justification,evidence?}]), docreview_close (name=doc, status=accept|skip, text=reason).",
    promptSnippet: "Change Relay run state (never edit state.json by hand)",
    parameters: Type.Object({
      action: StringEnum(["init", "open", "get", "set_phase", "pr_draft", "finalize", "step", "counter", "approval", "slice", "checks", "question", "answer", "artifact", "lesson_add", "lessons_for", "unlock", "merge_research", "review_lenses", "consolidate_review", "docreview_lenses", "docreview_consolidate", "docreview_resolve", "docreview_close"] as const),
      slug: Type.Optional(Type.String()),
      requirement: Type.Optional(Type.String()),
      phase: Type.Optional(Type.String()),
      name: Type.Optional(Type.String({ description: "step id, counter name, approval name, slice id, artifact name" })),
      status: Type.Optional(Type.String()),
      agent: Type.Optional(Type.String()),
      cap: Type.Optional(Type.Number()),
      path: Type.Optional(Type.String({ description: "artifact path relative to repo root" })),
      commit: Type.Optional(Type.String()),
      commands: Type.Optional(Type.Record(Type.String(), Type.String())),
      text: Type.Optional(Type.String({ description: "question text / answered question" })),
      role: Type.Optional(Type.String()),
      symptom: Type.Optional(Type.String()),
      rule: Type.Optional(Type.String()),
      signature: Type.Optional(Type.String({ description: "failure signature; lesson_add requires counter failure:<signature> >= 2" })),
      takeover: Type.Optional(Type.Boolean()),
      worktree: Type.Optional(Type.Boolean({ description: "init/open: default true = run the feature in its own git worktree (branch relay/<slug>); false = in place" })),
      base: Type.Optional(Type.String({ description: "init: base ref for the new worktree branch (default HEAD)" })),
      dir: Type.Optional(Type.String({ description: "workspace mode: run an in-place (worktree=false) feature inside this child repo directory (used by /relay-init per-repo scouts)" })),
    }),
    async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
      const repoCwd = p.dir ? path.resolve(ctx.cwd || process.cwd(), p.dir) : ctx.cwd || process.cwd();
      let cwd = rootOf(ctx);
      const lock = () => path.join(cwd, featureDir(), ".lock");
      try {
        if (p.action === "init") {
          if (!p.slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug)) return text("error: slug must be kebab-case");
          if (!p.requirement) return text("error: requirement required");
          let wt: any;
          let wsInit: any;
          const wsd = (WS.detectWorkspace as any)(repoCwd, configOf(repoCwd));
          if (wsd.mode === "workspace" && p.worktree !== false) {
            try {
              const c = WS.ensureContainer(wsd.root, p.slug, wsd.repos.map((r: any) => r.name));
              wt = { path: c.path, branch: c.branch, base: "HEAD", created: c.created };
              wsInit = { root: wsd.root, repos: {} };
              const empty = wsd.repos.filter((r: any) => !r.hasCommit).map((r: any) => r.name);
              if (empty.length) return text(`error: repo(s) without a commit: ${empty.join(", ")}. Make an initial commit or exclude them via relay.config.json workspace.exclude.`);
            } catch (e: any) { return text(`error: cannot create workspace feature container: ${e.message}`); }
          } else if (wsd.mode === "none" && p.worktree !== false) {
            return text("error: this directory is neither a git repo nor a workspace containing git repos (child dirs with .git).");
          } else if (p.worktree !== false) {
            try { wt = ensureWorktree(repoCwd, p.slug, { base: p.base }); }
            catch (e: any) { return text(`error: cannot create worktree (use worktree=false to run in place): ${e.message}`); }
            excludeHarnessFiles(wt.path);
          }
          cwd = wt ? wt.path : repoCwd;
          slug = p.slug;
          if (fs.existsSync(stateFile(cwd))) { slug = undefined; return text(`error: feature already exists${wt ? ` in ${cwd}` : ""}; use open`); }
          root = cwd;
          fs.mkdirSync(path.join(cwd, featureDir(), "evidence"), { recursive: true });
          fs.mkdirSync(path.join(cwd, featureDir(), "reports"), { recursive: true });
          const lk = S.acquireLock(lock());
          if (!lk.ok) { slug = undefined; root = undefined; return text("error: lock held"); }
          const worktree = wt ? { path: wt.path, branch: wt.branch, base: wt.base, ...(wt.baseSha ? { baseSha: wt.baseSha } : {}) } : undefined;
          const ns: any = S.newState({ slug, requirement: p.requirement, worktree });
          if (wsInit) ns.workspace = wsInit;
          S.saveState(stateFile(cwd), ns, schema("state"));
          const lessons = path.join(cwd, ".ai", "lessons.md");
          if (!fs.existsSync(lessons)) fs.copyFileSync(path.join(RELAY_HOME, "templates", "lessons.md"), lessons);
          if (wsInit) return text(`initialised workspace feature ${featureDir()} in container ${wt.path} (branch ${wt.branch}, ${wt.created ? "created" : "re-attached"}). Workspace root ${wsInit.root}; repos: ${wsd.repos.map((r: any) => r.name).join(", ")}. Repo worktrees are created lazily for the repos the plan touches, as <container>/<repo>. Use absolute paths under the container for every feature file; reference repos by name (<repo>/path). Main checkouts at ${wsInit.root}\<repo> are read-only reference.`);
          return text(wt
            ? `initialised ${featureDir()} in worktree ${wt.path} (branch ${wt.branch}, ${wt.created ? "created" : "re-attached"}). ALL work happens there: use absolute paths under ${wt.path} for every write/read of feature files.`
            : `initialised ${featureDir()} in place (no worktree) at ${cwd}`);
        }
        if (p.action === "open") {
          slug = p.slug;
          if (!slug) return text("error: slug required");
          const found = p.worktree === false ? undefined : (() => {
            try {
              const wc = WS.containerPath(path.resolve(repoCwd), slug);
              if (!(WS.isGitRepo as any)(repoCwd) && fs.existsSync(path.join(wc, ".git"))) return { path: wc, branch: branchFor(slug) };
              return findWorktree(repoCwd, slug);
            } catch { return undefined; }
          })();
          cwd = found ? found.path : repoCwd;
          if (!fs.existsSync(stateFile(cwd))) { slug = undefined; return text(`error: no .ai/${p.slug}/state.json in ${cwd}${found ? "" : ` (no worktree on branch ${branchFor(p.slug)} found)`}`); }
          root = cwd;
          const lk = S.acquireLock(lock(), { takeover: !!p.takeover });
          if (!lk.ok) { slug = undefined; root = undefined; return text(`lock held by pid ${lk.pid} since ${lk.timestamp} (stale=${lk.stale}). If stale, confirm with the user and retry with takeover=true.`); }
          if (found) excludeHarnessFiles(found.path);
          const { state, errors } = S.loadState(stateFile(cwd), schema("state"));
          if (!state) return text(`state.json corrupt/invalid: ${errors.join("; ")}. Re-run the producing step.`);
          const report: any = { phase: state.phase, worktree: state.worktree ? { ...state.worktree, path: cwd } : null, hashMismatches: S.verifyArtifacts(state, cwd), runningSteps: [], missingCommits: [], pendingQuestions: state.pendingQuestions, pendingApprovals: [] };
          report.resumedFrom = state.paused ? { ...state.paused } : (lk as any).dead ? { reason: "previous session died (stale lock taken over)" } : undefined;
          report.interrupted = S.markInterrupted(state, state.paused ? "paused" : "interrupted (session died)");
          for (const [id, s] of Object.entries<any>(state.steps)) if (s.status === "interrupted") report.runningSteps.push(id);
          if (report.interrupted.length) {
            // a killed worker may have left partial writes in the feature worktree; park them so the re-run starts clean
            try { if ((stashPartialWork as any)(cwd, `${slug} ${report.interrupted.join(",")}`)) report.stashedPartialWork = true; } catch { /* best effort */ }
            const wmk = readMarker(cwd);
            if (wmk?.repos) try { const sr = WS.stashPartialRepos(cwd, wmk.repos, `${slug} ${report.interrupted.join(",")}`); if (sr.length) { report.stashedPartialWork = true; report.stashedRepos = sr; } } catch { /* best effort */ }
          }
          delete state.paused;
          pausedNow = false;
          S.saveState(stateFile(cwd), state, schema("state"));
          if (report.interrupted.length) report.note = "interrupted steps/slices must be RE-RUN (their partial output was discarded; counters and finished work are kept)";
          for (const [id, s] of Object.entries<any>(state.slices)) {
            if (s.status !== "merged" || !s.commit) continue;
            try { git(s.repo ? path.join(cwd, s.repo) : cwd, "merge-base", "--is-ancestor", s.commit, "HEAD"); } catch { report.missingCommits.push(id); }
          }
          for (const [n, v] of Object.entries(state.approvals)) if (v === "pending") report.pendingApprovals.push(n);
          try { report.dirty = git(cwd, "status", "--porcelain").split("\n").filter(Boolean); } catch { report.dirty = ["(git unavailable)"]; }
          for (const rn of Object.keys(state.workspace?.repos || {})) { try { report.dirty.push(...git(path.join(cwd, rn), "status", "--porcelain").split("\n").filter(Boolean).map((l: string) => `${rn}: ${l}`)); } catch { /* repo worktree missing */ } }
          if (state.workspace) report.workspace = { root: state.workspace.root, repos: Object.keys(state.workspace.repos) };
          return text(JSON.stringify(report, null, 2), report);
        }
        if (!slug) return text("error: no active feature; call init or open first");
        if (p.action === "get") return text(fs.readFileSync(stateFile(cwd), "utf8"));
        if (p.action === "merge_research") {
          const r = (mergeResearch as any)(cwd, featureDir(), p.text || "");
          return text(r.ok ? `research.md merged from topics: ${r.topics.join(", ")}` : `error: ${r.error}`);
        }
        if (p.action === "review_lenses") {
          let cfg: any = {};
          for (const b of cfgBases(cwd)) { const f = path.join(b, "relay.config.json"); if (fs.existsSync(f)) { try { cfg = readJson(f); } catch { /* ignore */ } break; } }
          const st0 = readJson(stateFile(cwd));
          const changed: string[] = st0.workspace
            ? Object.entries<any>(st0.workspace.repos).flatMap(([rn, ri]) => ((reviewChangedFiles as any)(path.join(cwd, rn), ri.baseSha || ri.base, defaultBranch(path.join(cwd, rn))) as string[]).map((f) => `${rn}/${f}`))
            : (reviewChangedFiles as any)(cwd, st0.worktree?.base, defaultBranch(cwd));
          return text(JSON.stringify({ lenses: (reviewLenses as any)(cfg, changed), maxRounds: 2 }));
        }
        if (p.action === "consolidate_review") {
          const want = p.text ? String(p.text).split(",").map((s) => s.trim()).filter(Boolean) : null;
          const gate: any = withState(cwd, (st: any) => (reviewRerun as any)(st, want));
          if (!gate.ok) return text(`error: ${gate.error}`);
          const r = (consolidateReview as any)(cwd, featureDir(), schema("review-lens"), want);
          return text(r.ok ? JSON.stringify(r) : `error: ${r.error}`);
        }
        if (p.action.startsWith("docreview_")) {
          const doc = String(p.name || "");
          if (!DR.DOCS.includes(doc)) return text("error: name must be spec or design");
          const dcfg = DR.docReviewConfig(configOf(cwd), doc);
          if (p.action === "docreview_lenses") return text(JSON.stringify({ doc, enabled: dcfg.enabled, lanes: dcfg.lenses.map((l: string) => `${doc}-${l}`), maxRounds: dcfg.maxRounds, documents: DR.docFiles(doc).map((n: string) => `${featureDir()}/${n}`) }));
          if (p.action === "docreview_consolidate") {
            const gate: any = withState(cwd, (st: any) => DR.docReviewRound(st, doc, dcfg.maxRounds));
            if (!gate.ok) return text(`error: ${gate.error}`);
            const r: any = DR.consolidateDocReview(cwd, featureDir(), doc, schema("docreview-lens"), { lenses: dcfg.lenses, round: gate.round, config: dcfg });
            if (!r.ok) withState(cwd, (st: any) => { st.counters[`docreview-${doc}`].count -= 1; });
            return text(r.ok ? JSON.stringify(r) : `error: ${r.error}`);
          }
          if (p.action === "docreview_resolve") {
            let ds: any; try { ds = JSON.parse(p.text || ""); } catch (e: any) { return text(`error: text must be a JSON array of decisions: ${e.message}`); }
            const r: any = DR.resolveDocReview(cwd, featureDir(), doc, ds);
            return text(r.ok ? JSON.stringify(r) : `error: ${r.error}`);
          }
          const r: any = DR.closeDocReview(cwd, featureDir(), doc, p.status || "", p.text || "");
          return text(r.ok ? `${doc} review ${r.status}` : `error: ${r.error}`);
        }
        if (p.action === "unlock") { S.releaseLock(lock()); return text("lock released"); }
        if (p.action === "lessons_for") {
          const f = path.join(cwd, ".ai", "lessons.md");
          const l = fs.existsSync(f) ? lessonsFor(fs.readFileSync(f, "utf8"), p.role) : [];
          return text(JSON.stringify(l, null, 2));
        }
        if (p.action === "lesson_add") {
          const st = readJson(stateFile(cwd));
          const c = st.counters[`failure:${p.signature}`];
          if (!p.signature || !c || c.count < 2) return text("refused: lessons need the same failure twice (counter failure:<signature> >= 2)");
          const f = path.join(cwd, ".ai", "lessons.md");
          const cur = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : fs.readFileSync(path.join(RELAY_HOME, "templates", "lessons.md"), "utf8");
          S.writeFileAtomic(f, addLesson(cur, { date: new Date().toISOString().slice(0, 10), role: p.role, symptom: p.symptom, rule: p.rule }));
          return text("lesson recorded");
        }
        const out = withState(cwd, (st: any) => {
          switch (p.action) {
            case "set_phase":
              if (!S.PHASES.includes(p.phase)) throw new Error(`unknown phase ${p.phase}`);
              if (p.phase === "done") throw new Error("use harness_state action=finalize (after pr_draft) to finish the run");
              {
                const miss = phaseRequires(p.phase, featureDir()).filter((f: string) => !fs.existsSync(path.join(cwd, f)));
                if (miss.length) throw new Error(`cannot enter ${p.phase}: missing ${miss.join(", ")}. Re-run the producing worker.`);
                try { (recordLessons as any)(cwd, readJson(path.join(cwd, featureDir(), "holdout", "results.json"))); } catch { /* no results yet */ }
                const probs = (phaseProblems as any)({ lessons: (loadLessons as any)(cwd), phase: p.phase, cwd, featureDir: featureDir(), state: st, schemas: gateSchemas(), threshold: satThreshold(cwd), requiredApprovals: (requiredApprovals as any)(configOf(cwd)), requiredChecks: checkGate(cwd, st).required, head: checkGate(cwd, st).head, docReview: DR.docReviewConfig(configOf(cwd), "spec").enabled });
                probs.push(...checkGate(cwd, st).extra);
                if (probs.length) throw new Error(`cannot enter ${p.phase}:\n- ${probs.join("\n- ")}`);
              }
              st.phase = p.phase; return `phase=${p.phase}`;
            case "pr_draft": {
              if (!p.text) throw new Error("text (PR summary) required; caveats go in 'caveats'");
              const fe = readJson(path.join(cwd, featureDir(), "features.json"));
              const probs = (phaseProblems as any)({ phase: "pr", cwd, featureDir: featureDir(), state: st, schemas: gateSchemas(), threshold: satThreshold(cwd), requiredApprovals: (requiredApprovals as any)(configOf(cwd)), requiredChecks: checkGate(cwd, st).required, head: null });
              if (probs.length) throw new Error(`cannot draft PR:\n- ${probs.join("\n- ")}`);
              const ev = path.join(cwd, featureDir(), "evidence");
              const checkLogs = fs.existsSync(ev) ? fs.readdirSync(ev).filter((n) => /^checks-.*\.log$/.test(n)).sort() : [];
              const checks = checkLogs.map((n) => {
                const t = fs.readFileSync(path.join(ev, n), "utf8");
                return `\`${featureDir()}/evidence/${n}\`: ${/^# RESULT: (PASS|FAIL)/m.exec(t)?.[1] ?? "?"}`;
              });
              const base = st.worktree?.base && st.worktree.base !== "HEAD" ? st.worktree.base : defaultBranch(cwd);
              const branch = st.worktree?.branch || git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
              let commits: string[] = [], diffStat = "";
              const wsSums = st.workspace ? WS.repoSummaries(cwd, st.workspace) : null;
              if (wsSums) { commits = wsSums.flatMap((s: any) => s.commits.map((c: string) => `[${s.name}] ${c}`)); diffStat = wsSums.map((s: any) => `# ${s.name}\n${s.diffStat}`).join("\n"); }
              else try { commits = git(cwd, "log", "--oneline", `${base}..HEAD`).split("\n").filter(Boolean); diffStat = git(cwd, "diff", "--stat", `${base}...HEAD`); } catch { /* base unknown */ }
              const rv = fs.readFileSync(path.join(cwd, featureDir(), "reports", "review.md"), "utf8");
              const reports = fs.readdirSync(path.join(cwd, featureDir(), "reports")).filter((n) => /^verify-.*\.json$/.test(n)).map((n) => `${featureDir()}/reports/${n}`);
              let sat: any = null;
              try { sat = (holdoutResultProblems as any)(cwd, featureDir(), gateSchemas(), 0).sat; } catch { /* no holdouts */ }
              const md = (renderPr as any)({ satisfaction: sat, slug, title: p.name || slug, summary: p.text, caveats: p.symptom ? String(p.symptom).split("\n").filter(Boolean) : [], features: fe, featureDir: featureDir(), branch, base, checks, commits, diffStat, reviewExcerpt: rv.slice(0, 1500), verifyReports: reports });
              if (wsSums) {
                const md2 = md.replace(/## Create the PR[\s\S]*$/, WS.multiRepoCreateSection(wsSums, featureDir()) + "\n");
                S.writeFileAtomic(path.join(cwd, featureDir(), "pr.md"), md2);
                for (const s of wsSums) S.writeFileAtomic(path.join(cwd, featureDir(), `pr-${s.name}.md`), WS.renderRepoPr({ slug: slug!, title: p.name || slug!, summary: p.text, repo: s.name, summaries: wsSums, root: st.workspace.root }));
                return `pr.md + ${wsSums.map((s: any) => `pr-${s.name}.md`).join(", ")} written. Next: harness_state action=finalize`;
              }
              S.writeFileAtomic(path.join(cwd, featureDir(), "pr.md"), md);
              return `pr.md written (${md.length} chars). Next: harness_state action=finalize`;
            }
            case "finalize": {
              if (st.phase !== "pr") throw new Error(`finalize requires phase=pr (now ${st.phase})`);
              const probs = (phaseProblems as any)({ phase: "done", cwd, featureDir: featureDir(), state: st, schemas: gateSchemas(), threshold: satThreshold(cwd), requiredApprovals: (requiredApprovals as any)(configOf(cwd)), requiredChecks: checkGate(cwd, st).required, head: null });
              if (probs.length) throw new Error(`cannot finalize:\n- ${probs.join("\n- ")}`);
              st.phase = "done";
              return "__finalize__";
            }
            case "step":
              if (p.status === "running") S.beginStep(st, p.name, { agent: p.agent });
              else S.finishStep(st, p.name, { status: p.status });
              return `step ${p.name} ${p.status}`;
            case "counter": {
              const r = S.bump(st, p.name, p.cap);
              return `${p.name}: ${r.count}/${r.cap}${r.exceeded ? " CAP EXCEEDED: escalate to the user" : ""}`;
            }
            case "approval":
              if (p.status !== "pending") throw new Error("only relay_approval can approve/reject; this action sets 'pending'");
              st.approvals[p.name] = "pending"; return `approval ${p.name} pending`;
            case "slice":
              st.slices[p.name] = { status: p.status, ...(p.commit ? { commit: p.commit } : {}) };
              return `slice ${p.name} ${p.status}`;
            case "checks": st.checks = { ...st.checks, ...p.commands }; return "checks saved";
            case "question":
              st.pendingQuestions.push(p.text); return "question queued";
            case "answer":
              st.pendingQuestions = st.pendingQuestions.filter((q: string) => q !== p.text); return "question cleared";
            case "artifact": {
              const abs = path.join(cwd, p.path);
              st.artifacts[p.name] = { path: posix(p.path), sha256: S.sha256File(abs) };
              return `artifact ${p.name} recorded`;
            }
          }
          throw new Error(`unknown action ${p.action}`);
        });
        if (out === "__finalize__") {
          const c = (commitArtefacts as any)(cwd, featureDir(), `relay: ${slug} artefacts (spec, design, plan, evidence, pr.md)`);
          if (!c.ok) {
            withState(cwd, (st: any) => { st.phase = "pr"; });
            return text(`finalize refused: ${c.error}`);
          }
          S.releaseLock(lock());
          const fst = readJson(stateFile(cwd));
          if (fst.workspace) {
            const sums = WS.repoSummaries(cwd, fst.workspace);
            const dirty = sums.filter((s: any) => s.dirty.length).map((s: any) => `${s.name} (${s.dirty.length} uncommitted)`);
            return text(`done. Workspace feature: artefacts committed in the container (${String(c.commit).slice(0, 8)}); repo branches: ${sums.map((s: any) => `${s.name}=${s.branch} (${s.commits.length} commits)`).join(", ")}. Nothing pushed yet. PR texts: ${featureDir()}/pr.md and pr-<repo>.md. Next: relay_pr plan, then relay_pr open (asks the user; disabled by pr.auto=false).${dirty.length ? ` WARNING uncommitted changes in: ${dirty.join(", ")}.` : ""}`);
          }
          return text(`done. Artefacts committed (${String(c.commit).slice(0, 8)}) on branch ${readJson(stateFile(cwd)).worktree?.branch ?? "(in place)"}. Nothing pushed yet. PR text: ${featureDir()}/pr.md. Next: relay_pr plan, then relay_pr open (asks the user; disabled by pr.auto=false).`);
        }
        return text(String(out));
      } catch (e: any) {
        return text(`error: ${e.message}`);
      }
    },
  });

  const initTool = () => pi.registerTool({
    name: "relay_init",
    label: "Repo init",
    description: "Prepare a repo for Relay (/relay-init). Actions: workspace_plan (workspace root: per-repo init status), preflight, bootstrap_git, detect, preview, apply (items: agents-md|gitignore|config), install_verifier, baseline, commit, report. Anything that writes user files or installs software asks the user to confirm first, regardless of autonomy.",
    parameters: Type.Object({
      action: StringEnum(["preflight", "bootstrap_git", "detect", "preview", "apply", "install_verifier", "baseline", "commit", "report", "workspace_plan"] as const),
      items: Type.Optional(Type.Array(Type.String())),
      refresh: Type.Optional(Type.Boolean()),
      repo: Type.Optional(Type.String({ description: "workspace (multi-repo) mode: run the action inside this child repo; omit to act on the workspace root (repo map, workspace AGENTS.md/config, verifier tools)" })),
    }),
    async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
      const base0 = ctx.cwd ?? process.cwd();
      const wsd0: any = (WS.detectWorkspace as any)(base0, configOf(base0));
      const wsMode = wsd0.mode === "workspace" && !p.repo;
      if (p.repo && wsd0.mode === "workspace" && !wsd0.repos.some((r: any) => r.name === p.repo)) return text(`error: unknown repo ${p.repo} (workspace repos: ${wsd0.repos.map((r: any) => r.name).join(", ")})`);
      const cwd = p.repo && wsd0.mode === "workspace" ? path.join(base0, p.repo) : base0;
      const dir = path.join(cwd, ".ai", I.INIT_SLUG);
      const rel = (f: string) => posix(path.relative(cwd, f));
      const ask = async (title: string, msg: string): Promise<boolean> => ctx.hasUI ? !!(await ctx.ui.confirm(title, msg)) : false;
      const stateP = path.join(dir, "init.json");
      const st: any = fs.existsSync(stateP) ? readJson(stateP) : { applied: [], skipped: [], written: [] };
      const save = () => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(stateP, JSON.stringify(st, null, 2)); };
      const detection = () => {
        if (!wsMode) return I.detect(cwd);
        // workspace root: repos with a UI decide verifier tooling; checks are per repo (use repo=<name>)
        const per = wsd0.repos.map((r: any) => ({ name: r.name, d: I.detect(r.path) }));
        return { ...(per.find((x: any) => x.d.ui?.length || x.d.ui === true)?.d || per[0].d), perRepo: Object.fromEntries(per.map((x: any) => [x.name, { stacks: x.d.stacks, apps: x.d.apps, checks: x.d.checks, ui: x.d.ui }])) };
      };
      const wsDets = () => Object.fromEntries(wsd0.repos.map((r: any) => [r.name, I.detect(r.path)]));
      const wsDraft = () => { const dets = wsDets(); const rels = (WI.relations as any)(wsd0.repos, dets); const repoAgents = Object.fromEntries(wsd0.repos.map((r: any) => [r.name, (WI.repoInitStatus as any)(r).agentsMd])); return { dets, draft: (WI.renderWorkspaceAgents as any)(wsd0.repos, dets, rels, { repoAgents }) as string }; };
      const readIf = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
      try {
        switch (p.action) {
          case "workspace_plan": {
            if (!wsMode) return text("not at a workspace root; use repo=<name> or run in the parent folder");
            let cfg: any = {}; try { cfg = readJson(path.join(cwd, "relay.config.json")); } catch { /* none */ }
            const scanned = (WS.listRepos as any)(cwd, {}).map((r: any) => r.name);
            const listed = wsd0.repos.map((r: any) => r.name);
            const excluded = (cfg.workspace?.exclude || []).map(String);
            const unlisted = scanned.filter((n: string) => !listed.includes(n) && !excluded.includes(n));
            return text(JSON.stringify({ mode: "workspace", root: cwd, repos: wsd0.repos.map((r: any) => (WI.repoInitStatus as any)(r)), unlistedRepos: unlisted, note: unlisted.length ? "these child repos are not in relay.config.json workspace.repos; Relay will not touch them unless you add them" : undefined, next: "for each repo: harness_state init worktree=false dir=<repo> slug=repo-init, run relay-repo-scout, then relay_init repo=<name> preview/apply/install_verifier/baseline/commit; finally at the root: apply items=[config, agents-md]" }, null, 2));
          }
          case "preflight":
            if (wsMode) return text(JSON.stringify({ mode: "workspace", root: cwd, note: "parent is not a git repo (expected). Init each repo with repo=<name>; Relay will not git-init or commit the workspace root.", repos: wsd0.repos }, null, 2));
            return text(JSON.stringify(I.preflight(cwd), null, 2));
          case "bootstrap_git": {
            if (wsMode) return text("refused: the workspace root is deliberately not a git repo. Use repo=<name> for child repos.");
            const pf = I.preflight(cwd);
            if (pf.isRepo && pf.commits > 0) return text("already a git repo with commits; nothing to do");
            if (!(await ask("Initialise git?", `${pf.isRepo ? "This repo has no commits." : "This folder is not a git repo."} Relay needs a repo with at least one commit. Run 'git init -b main' and make an initial commit of the current files?`))) return text("declined; /relay-init cannot continue without a git repo with a commit");
            const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=Relay", "-c", "user.email=relay@localhost", ...a], { cwd, encoding: "utf8" }).trim();
            if (!pf.isRepo) g("init", "-q", "-b", "main");
            const gi = path.join(cwd, ".gitignore");
            if (!fs.existsSync(gi)) fs.writeFileSync(gi, "node_modules/\n.env\n.env.*\n");
            g("add", "-A"); g("commit", "-q", "-m", "chore: initial commit (relay init)");
            return text(`git ready: ${g("rev-parse", "--short", "HEAD")}`);
          }
          case "detect": {
            const d = detection();
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "detection.json"), JSON.stringify(d, null, 2));
            return text(`detection written to ${rel(path.join(dir, "detection.json"))}\n${JSON.stringify({ stacks: d.stacks, apps: d.apps, checks: d.checks, ui: d.ui, ci: d.ci, runtime: d.runtime }, null, 2)}`);
          }
          case "preview": {
            const d = detection();
            const draft = readIf(path.join(dir, "agents-draft.md"));
            const ex = readIf(path.join(cwd, "AGENTS.md"));
            const wsd = wsMode ? wsDraft() : null;
            const m = wsd ? I.mergeAgentsMd(ex, wsd.draft) : draft ? I.mergeAgentsMd(ex, draft) : null;
            const gi = I.mergeGitignore(readIf(path.join(cwd, ".gitignore")));
            let cfg: any = {}; try { cfg = readJson(path.join(cwd, "relay.config.json")); } catch { /* none */ }
            const mc = wsd ? (WI.mergeWorkspaceConfig as any)(cfg, wsd0.repos, wsd.dets) : I.mergeConfig(cfg, d, st.verifier);
            return text([
              m ? `AGENTS.md (${m.mode}${m.changed ? "" : ", unchanged"}):\n${ex ? I.unifiedDiff(ex, m.content) || "(no change)" : m.content}` : "AGENTS.md: no draft yet (run the repo scout)",
              wsMode ? ".gitignore: not touched at the workspace root (per repo)" : `.gitignore: add ${gi.added.join(", ") || "nothing"}`,
              `relay.config.json: add keys ${mc.added.join(", ") || "nothing"}`,
              `verifier plan: ${JSON.stringify(I.verifierPlan(d))}`,
            ].join("\n\n"));
          }
          case "apply": {
            const d = detection();
            const want: string[] = (p.items?.length ? p.items : ["agents-md", "gitignore", "config"]).filter((i: string) => !(wsMode && i === "gitignore"));
            const out: string[] = [];
            for (const item of want) {
              if (item === "agents-md") {
                const draft = wsMode ? wsDraft().draft : readIf(path.join(dir, "agents-draft.md"));
                if (!draft) { out.push("agents-md: no draft; run the repo scout first"); continue; }
                const ex = readIf(path.join(cwd, "AGENTS.md"));
                const m = I.mergeAgentsMd(ex, draft);
                if (!m.changed) { out.push("agents-md: already up to date"); continue; }
                const shown = ex ? I.unifiedDiff(ex, m.content) : m.content;
                if (!(await ask(`Write AGENTS.md (${m.mode})?`, shown.slice(0, 6000)))) { st.skipped.push("AGENTS.md (declined)"); out.push("agents-md: declined"); continue; }
                S.writeFileAtomic(path.join(cwd, "AGENTS.md"), m.content);
                st.written.push("AGENTS.md"); st.applied.push(`AGENTS.md ${m.mode}`); out.push(`agents-md: written (${m.mode})`);
              } else if (item === "gitignore") {
                const f = path.join(cwd, ".gitignore");
                const g = I.mergeGitignore(readIf(f));
                if (!g.added.length) { out.push("gitignore: already complete"); continue; }
                if (!(await ask("Update .gitignore?", `Add:\n${g.added.join("\n")}`))) { st.skipped.push(".gitignore (declined)"); out.push("gitignore: declined"); continue; }
                S.writeFileAtomic(f, g.content);
                st.written.push(".gitignore"); st.applied.push(`.gitignore +${g.added.length}`); out.push(`gitignore: added ${g.added.join(", ")}`);
              } else if (item === "config") {
                const f = path.join(cwd, "relay.config.json");
                let cur: any = null; try { cur = readJson(f); } catch { /* none */ }
                const c = wsMode ? (WI.mergeWorkspaceConfig as any)(cur, wsd0.repos, wsDets()) : I.mergeConfig(cur, d, st.verifier);
                if (!c.added.length) { out.push("config: nothing to add"); continue; }
                const shown = JSON.stringify(Object.fromEntries(c.added.map((k: string) => [k, c.config[k]])), null, 2);
                if (!(await ask(`${cur ? "Update" : "Create"} relay.config.json?`, shown))) { st.skipped.push("relay.config.json (declined)"); out.push("config: declined"); continue; }
                S.writeFileAtomic(f, JSON.stringify(c.config, null, 2) + "\n");
                st.written.push("relay.config.json"); st.applied.push(`relay.config.json +${c.added.join(",")}`); out.push(`config: added ${c.added.join(", ")}`);
              }
            }
            save();
            return text(out.join("\n"));
          }
          case "install_verifier": {
            const plan = I.verifierPlan(detection());
            const item = plan.items[0];
            if (!item) return text(`nothing to install.\n${plan.notes.join("\n")}`);
            const tools = path.join(cwd, I.TOOLS_DIR);
            if (!p.refresh && fs.existsSync(path.join(tools, "node_modules", "playwright")) && fs.existsSync(path.join(tools, "shot.mjs"))) { st.verifier = { tools: I.TOOLS_DIR, shot: `${I.TOOLS_DIR}/shot.mjs`, kind: "playwright" }; save(); return text("verifier tooling already installed (use refresh to reinstall)"); }
            if (!(await ask("Install browser verifier tooling?", `${item.summary}\n\nWill run in ${I.TOOLS_DIR}:\n${item.commands.join("\n")}\n\nDownloads Chromium (~150MB).\n${plan.notes.join("\n")}`))) { st.skipped.push("verifier tooling (declined)"); save(); return text("declined"); }
            fs.mkdirSync(tools, { recursive: true });
            if (!fs.existsSync(path.join(tools, "package.json"))) fs.writeFileSync(path.join(tools, "package.json"), JSON.stringify({ name: "relay-verifier-tools", private: true, type: "module" }, null, 2) + "\n");
            fs.writeFileSync(path.join(tools, "shot.mjs"), I.SHOT_SCRIPT);
            for (const c of item.commands) {
              let r = spawnSync(c, { cwd: tools, shell: true, encoding: "utf8", timeout: 10 * 60_000 });
              if (r.status !== 0 && /npm install/.test(c)) {
                // the registry's `latest` tag may be an unpublishable alpha: retry with the newest stable release
                const vs = spawnSync("npm view playwright versions --json", { cwd: tools, shell: true, encoding: "utf8", timeout: 60_000 });
                const stable = I.latestStable(vs.stdout || "");
                if (stable) r = spawnSync(`${c}@${stable}`, { cwd: tools, shell: true, encoding: "utf8", timeout: 10 * 60_000 });
              }
              if (r.status !== 0) { const err = maskText(`${r.stdout}\n${r.stderr}`).slice(-600); st.verifier = { status: "failed", detail: `${c}: ${err.replace(/\s+/g, " ").trim().slice(-300)}` }; save(); return text(`FAILED: ${c}\n${err}`); }
            }
            const shotsDir = path.join(dir, "evidence"); fs.mkdirSync(shotsDir, { recursive: true });
            const png = path.join(shotsDir, "smoke.png");
            fs.rmSync(png, { force: true });
            const sm = spawnSync(process.execPath, [path.join(tools, "shot.mjs"), "data:text/html,<h1>relay smoke</h1>", png], { cwd, encoding: "utf8", timeout: 120_000 });
            const ok = sm.status === 0 && fs.existsSync(png) && fs.statSync(png).size > 0;
            st.verifier = ok ? { tools: I.TOOLS_DIR, shot: `${I.TOOLS_DIR}/shot.mjs`, kind: "playwright", status: "installed; smoke screenshot ok", detail: rel(png) } : { status: "failed", detail: "smoke test" };
            if (ok) { st.written.push(`${I.TOOLS_DIR}/package.json`, `${I.TOOLS_DIR}/shot.mjs`); st.applied.push("verifier tooling (playwright)"); }
            save();
            return text(ok ? `installed; smoke screenshot ${rel(png)} (${fs.statSync(png).size} bytes)\n${plan.notes.join("\n")}` : `smoke test FAILED\n${maskText(`${sm.stdout}\n${sm.stderr}`).slice(-1500)}\n${plan.notes.join("\n")}`);
          }
          case "baseline": {
            if (wsMode) return text("run baseline per repo: relay_init action=baseline repo=<name>");
            const d = detection();
            let cfg: any = {}; try { cfg = readJson(path.join(cwd, "relay.config.json")); } catch { /* none */ }
            const checks = { ...d.checks, ...(cfg.checks || {}) };
            if (!Object.keys(checks).length) return text("no checks detected; nothing to baseline");
            if (!(await ask("Run baseline checks?", `Runs (may take a while):\n${Object.entries(checks).map(([k, v]) => `${k}: ${v}`).join("\n")}`))) return text("declined");
            st.baseline = I.runBaseline(cwd, checks, { evidenceDir: path.join(dir, "evidence") });
            save();
            fs.writeFileSync(path.join(dir, "baseline.json"), JSON.stringify(st.baseline, null, 2));
            return text(Object.entries(st.baseline).map(([k, v]: any) => `${k}: ${v.status}${v.evidence ? ` [${v.evidence}]` : ""}`).join("\n"));
          }
          case "commit": {
            if (wsMode) return text("nothing to commit: the workspace root is not a git repo (its files stay local). Commit per repo with repo=<name>.");
            const files = [...new Set<string>(st.written)].filter((f) => fs.existsSync(path.join(cwd, f)));
            if (!files.length) return text("nothing written by init; nothing to commit");
            if (!(await ask("Commit init files?", `Commit (no push): ${files.join(", ")}`))) return text("declined");
            execFileSync("git", ["add", "--", ...files], { cwd });
            const lock = path.join(cwd, I.TOOLS_DIR, "package-lock.json");
            if (fs.existsSync(lock)) execFileSync("git", ["add", "--", rel(lock)], { cwd });
            const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf8" }).trim();
            if (!staged) return text("already committed");
            execFileSync("git", ["-c", "user.name=Relay", "-c", "user.email=relay@localhost", "commit", "-q", "-m", "chore: relay init (AGENTS.md, config, verifier tooling)\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"], { cwd });
            return text(`committed ${execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" }).trim()}; nothing pushed`);
          }
          case "report": {
            const d = detection();
            let pf: any = null; try { pf = I.preflight(cwd); } catch { /* skip */ }
            const rep = I.renderReport({ preflight: pf, detection: d, applied: st.applied, skipped: st.skipped, verifier: st.verifier, baseline: st.baseline, notes: I.verifierPlan(d).notes });
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "init-report.md"), rep);
            return text(rep);
          }
        }
      } catch (e: any) { return text(`error: ${e.message}`); }
      return text("unknown action");
    },
  });
  if (!IS_CHILD) initTool();

  if (!IS_CHILD) pi.registerTool({
    name: "relay_pr",
    label: "Open PRs",
    description: "Final step after finalize (phase done): push relay/<slug> and open one PR per affected repo with gh, bodies from pr.md / pr-<repo>.md, sibling PRs cross-linked, URLs recorded in state.prs. Actions: plan (read-only summary), open (asks the user to confirm first, regardless of autonomy; needs an interactive UI). Never forces, never pushes any branch except relay/<slug>, idempotent on resume. Disabled by relay.config.json pr.auto=false.",
    parameters: Type.Object({ action: StringEnum(["plan", "open"] as const) }),
    async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
      if (!slug) return text("error: no active feature (use harness_state open)");
      const cwd = rootOf(ctx);
      try {
        const st = readJson(stateFile(cwd));
        if (st.phase !== "done") return text(`error: relay_pr runs after finalize (phase is ${st.phase})`);
        const cfg = (PR.prConfig as any)(configOf(cwd));
        if (!cfg.auto) return text("PR creation is disabled (relay.config.json pr.auto=false). Use pr.md / pr-<repo>.md to open PRs manually.");
        const sums = st.workspace ? WS.repoSummaries(cwd, st.workspace) : null;
        const targets = (PR.prTargets as any)(st, path.join(cwd, featureDir()), sums);
        if (!targets.length) return text("nothing to open: no repo has commits on its feature branch");
        const plan = (PR.planPrs as any)({ targets, slug, existing: st.prs || {} });
        const summary = (PR.renderPlan as any)(plan);
        if (p.action === "plan") return text(summary);
        const blocked = plan.filter((x: any) => x.problems.length && !x.existing);
        if (!ctx.hasUI) return text(`error: opening PRs needs an interactive confirmation; PR text is in ${featureDir()}/pr*.md. Plan:\n${summary}`);
        if (!(await ctx.ui.confirm("Push branches and open PRs?", `${summary}\n\nOnly relay/${slug} is pushed (no force). One PR per repo via gh.${blocked.length ? "\nRepos with problems will be skipped and reported." : ""}`))) return text("declined by the user; nothing pushed. PR text left in pr*.md");
        const title = (fs.readFileSync(path.join(cwd, featureDir(), "pr.md"), "utf8").match(/^# (.+)$/m)?.[1] ?? slug).replace(/\s*\(.*\)$/, "");
        const res = (PR.openPrs as any)({ targets, slug, title, existing: st.prs || {}, draft: cfg.draft });
        withState(cwd, (s: any) => {
          s.prs = s.prs || {};
          for (const r of res) if (r.url) s.prs[r.name || "_"] = { url: r.url, branch: r.branch, at: new Date().toISOString() };
        });
        const c = (commitArtefacts as any)(cwd, featureDir(), `relay: ${slug} record PR URLs`);
        const lines = res.map((r: any) => `- ${r.name || "repo"}: ${r.status}${r.url ? " " + r.url : ""}${r.error ? " (" + r.error + ")" : ""}${r.linkWarning ? " [" + r.linkWarning + "]" : ""}`);
        return text(`${lines.join("\n")}\nPR URLs recorded in state.prs${c.ok ? "" : " (artefact commit failed: " + c.error + ")"}. Failed repos keep their pr text in ${featureDir()}/pr*.md; fix the cause and run relay_pr open again (existing PRs are reused).`);
      } catch (e: any) { return text(`error: ${e.message}`); }
    },
  });
  pi.registerTool({
    name: "relay_approval",
    label: "User approval",
    description: "Ask the user to approve a gate (e.g. spec, design). The only way an approval becomes approved/rejected. Needs an interactive UI.",
    parameters: Type.Object({ name: Type.String(), message: Type.String({ description: "what is being approved and where to read it" }) }),
    async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
      if (!slug) return text("error: no active feature");
      if (autonomyLevel(configOf(rootOf(ctx))) === "autonomous") {
        withState(rootOf(ctx), (st: any) => { st.approvals[p.name] = "approved"; });
        return text(`${p.name}: AUTO-APPROVED (autonomy=autonomous; no human reviewed this). Proceed.`);
      }
      if (!ctx.hasUI) return text("error: no interactive UI; ask the user in chat and wait");
      const ok = await ctx.ui.confirm(`Approve ${p.name}?`, p.message);
      withState(rootOf(ctx), (st: any) => { st.approvals[p.name] = ok ? "approved" : "rejected"; });
      return text(ok ? `${p.name}: approved` : `${p.name}: rejected; ask the user for feedback and loop`);
    },
  });

  pi.registerTool({
    name: "relay_checks",
    label: "Run checks",
    description: "Run the configured build/typecheck/lint/test commands (state.checks) and log output to evidence/. Ground truth; do not rely on agent claims.",
    parameters: Type.Object({ only: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
      if (!slug) return text("error: no active feature");
      const cwd = rootOf(ctx);
      const wsRepos = Object.keys(readJson(stateFile(cwd)).workspace?.repos || {});
      if (wsRepos.length) {
        // workspace feature: run each repo's checks in its own worktree; results are keyed "<repo>:<check>" with that repo's HEAD
        const rows: string[] = [];
        const results: Record<string, any> = {};
        const configured: Record<string, string> = {};
        let allOk = true; const missing: string[] = [];
        for (const repo of wsRepos) {
          const rdir = path.join(cwd, repo);
          const cmds = WS.repoChecks(rdir, repo, configOf(cwd).checks) as Record<string, string>;
          for (const name of requiredChecks(cwd)) if (!cmds[name]) missing.push(`${repo}:${name}`);
          for (const name of ["build", "typecheck", "lint", "sast", "test"]) {
            if (!cmds[name] || (p.only && !p.only.includes(name))) continue;
            const r = spawnSync(cmds[name], { cwd: rdir, shell: true, encoding: "utf8", timeout: 10 * 60_000 });
            const ok = r.status === 0;
            allOk = allOk && ok;
            configured[`${repo}:${name}`] = cmds[name];
            results[`${repo}:${name}`] = { ok, at: new Date().toISOString(), head: headOf(rdir) };
            const log = maskText(`# RESULT: ${ok ? "PASS" : "FAIL"}\n$ ${cmds[name]}\n${r.stdout}\n${r.stderr}`);
            const logRel = `${featureDir()}/evidence/checks-${repo}-${name}-${Date.now()}.log`;
            S.writeFileAtomic(path.join(cwd, logRel), log.slice(-20000));
            rows.push(`${ok ? "PASS" : "FAIL"} ${repo}:${name} (${logRel})${ok ? "" : "\n" + log.slice(-1500)}`);
          }
        }
        if (Object.keys(results).length) withState(cwd, (st: any) => {         st.checks = { ...st.checks, ...configured }; st.checkResults = { ...st.checkResults, ...results }; return "check results saved"; });
        const verdict = rows.length && !allOk ? "RED" : missing.length || !rows.length ? `NOT GREEN: required check(s) not configured: ${missing.join(", ") || "none ran"}. Configure relay.config.json checks (flat, or per repo: {"<repo>": {build,test,...}})` : "ALL GREEN";
        return text(`${verdict}\n${rows.join("\n")}`);
      }
      let checks = (readJson(stateFile(cwd)).checks || {}) as Record<string, string>;
      if (!Object.keys(checks).length && configOf(cwd).checks && typeof configOf(cwd).checks === "object") {
        checks = configOf(cwd).checks; // written by /relay-init
        withState(cwd, (st: any) => { st.checks = checks; return "checks from relay.config.json"; });
      }
      if (!Object.keys(checks).length) {
        // fall back to package.json scripts so an unconfigured repo is not "green" by default
        try {
          const scripts = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).scripts || {};
          checks = Object.fromEntries(["build", "typecheck", "lint", "test"].filter((n) => scripts[n]).map((n) => [n, `npm run ${n}`]));
          if (Object.keys(checks).length) withState(cwd, (st: any) => { st.checks = checks; return "checks autodetected"; });
        } catch { /* no package.json */ }
      }
      const rows: string[] = [];
      let allOk = true;
      const results: Record<string, any> = {};
      for (const name of ["build", "typecheck", "lint", "sast", "test"]) {
        if (!checks[name] || (p.only && !p.only.includes(name))) continue;
        const r = spawnSync(checks[name], { cwd, shell: true, encoding: "utf8", timeout: 10 * 60_000 });
        const ok = r.status === 0;
        allOk = allOk && ok;
        results[name] = { ok, at: new Date().toISOString(), head: headOf(cwd) };
        const log = maskText(`# RESULT: ${ok ? "PASS" : "FAIL"}\n$ ${checks[name]}\n${r.stdout}\n${r.stderr}`);
        const logRel = `${featureDir()}/evidence/checks-${name}-${Date.now()}.log`;
        S.writeFileAtomic(path.join(cwd, logRel), log.slice(-20000));
        rows.push(`${ok ? "PASS" : "FAIL"} ${name} (${logRel})${ok ? "" : "\n" + log.slice(-1500)}`);
      }
      if (Object.keys(results).length) withState(cwd, (st: any) => { st.checkResults = { ...st.checkResults, ...results }; return "check results saved"; });
      const missing = requiredChecks(cwd).filter((n) => !checks[n]);
      const verdict = rows.length && !allOk ? "RED" : missing.length || !rows.length ? `NOT GREEN: required check(s) not configured: ${missing.join(", ") || "none ran"}. Set with harness_state action=checks (commands: {build,typecheck,lint,sast,test})` : "ALL GREEN";
      return text(`${verdict}\n${rows.join("\n")}`);
    },
  });

  pi.registerTool({
    name: "relay_secret_scan",
    label: "Secret scan",
    description: "Heuristic secret scan of .ai/ and the staged diff. Run before committing.",
    parameters: Type.Object({}),
    async execute(_id: string, _p: any, _s: any, _u: any, ctx: any) {
      const cwd = rootOf(ctx);
      const hits: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f);
          else if (fs.statSync(f).size < 1_000_000) {
            for (const h of scanText(fs.readFileSync(f, "utf8"))) hits.push(`${posix(path.relative(cwd, f))}:${h.line} ${h.rule}`);
          }
        }
      };
      walk(path.join(cwd, ".ai"));
      try { for (const h of scanText(git(cwd, "diff", "--cached"))) hits.push(`staged diff:${h.line} ${h.rule}`); } catch { /* no git */ }
      return text(hits.length ? `SECRETS SUSPECTED (values not shown):\n${hits.join("\n")}` : "clean (heuristic)");
    },
  });

  const TaskSchema = Type.Object({
    agent: Type.String(),
    brief: Type.Object({
      objective: Type.String(),
      outputFormat: Type.String(),
      guidance: Type.String(),
      boundaries: Type.String(),
      inputs: Type.Array(Type.String(), { description: "full artefact paths" }),
    }),
    step: Type.Optional(Type.String({ description: "state step id for write-ahead tracking" })),
    slice: Type.Optional(Type.String({ description: "plan.json slice id (implementors)" })),
    lane: Type.Optional(Type.String({ description: "fan-out lane: research topic (relay-researcher -> research-<lane>.md) or review lens (relay-reviewer -> reports/review-<lane>.json); kebab-case" })),
    outputs: Type.Optional(Type.Array(Type.String(), { description: "expected output files, hashed into state on success" })),
  });

  const subagentTool: any = {
    name: "relay_subagent",
    label: "Relay sub-agent",
    description: "Run relay-* worker agents as isolated pi processes. mode: single (1 task), parallel (read-only agents, or implementors only if plan.json proves independence), chain (sequential; {previous} in later brief fields is replaced by prior output). background=true returns immediately and delivers the results as a follow-up message when the batch finishes, so the user can keep talking to you meanwhile (needs an interactive UI; otherwise it runs in the foreground). Do not start the next pipeline step until the completion message arrives.",
    promptSnippet: "Delegate to a relay-* worker agent with a structured brief",
    parameters: Type.Object({
      mode: StringEnum(["single", "parallel", "chain"] as const),
      tasks: Type.Array(TaskSchema, { minItems: 1 }),
      background: Type.Optional(Type.Boolean({ description: "run in the background and notify on completion (default: relay.config.json background, else false)" })),
    }),
    async execute(_id: string, p: any, signal: any, _u: any, ctx: any, onStarted?: () => void) {
      if (!slug) return text("error: no active feature; call harness_state init/open first");
      uiCtx = ctx;
      const cwd = rootOf(ctx);
      const wsMark = readMarker(cwd);
      const wsNames: string[] | null = wsMark?.repos?.length ? wsMark.repos : null;
      // lazily create the repo's feature worktree inside the container and record it in state.workspace
      const attachRepo = (c: string, repo: string) => {
        if (!wsNames!.includes(repo)) throw new Error(`unknown repo "${repo}" (workspace repos: ${wsNames!.join(", ")})`);
        const known = readJson(stateFile(c)).workspace?.repos?.[repo];
        const wt = WS.ensureRepoWorktree(wsMark.root, c, slug!, repo, { base: known?.base && known.base !== "HEAD" ? known.base : undefined, repoPath: known?.path });
        if (!known) withState(c, (st: any) => { st.workspace = st.workspace || { root: wsMark.root, repos: {} }; st.workspace.repos[repo] = { path: path.join(wsMark.root, repo), branch: wt.branch, base: wt.base, ...(wt.baseSha ? { baseSha: wt.baseSha } : {}) }; return "repo attached"; });
      };
      const wantBg = (p.background ?? configOf(cwd).background ?? false) && ctx.hasUI && !onStarted;
      if (wantBg) {
        const hasImpl = p.tasks.some((t: any) => t.agent === "relay-implementor");
        if (hasImpl && [...batches.values()].some((b) => b.hasImpl)) return text("error: an implementor batch is already running in the background; wait for its completion message");
        const id = `b${Date.now().toString(36)}`;
        const ac = new AbortController();
        let started!: () => void;
        const startedP = new Promise<null>((r) => { started = () => r(null); });
        const desc = p.tasks.map((t: any) => `${t.agent}${t.lane || t.slice ? `(${t.lane || t.slice})` : ""}`).join(", ");
        const doneP = Promise.resolve(subagentTool.execute(_id, { ...p, background: false }, ac.signal, _u, ctx, started))
          .catch((e: any) => text(`error: ${e?.message || e}`));
        const first = await Promise.race([startedP, doneP]);
        if (first) return first;
        batches.set(id, { ac, desc, hasImpl, startedAt: Date.now() });
        doneP.then((res: any) => {
          batches.delete(id);
          touch();
          const body = res?.content?.map((c: any) => c.text).join("\n") ?? "";
          try {
            pi.sendMessage({ customType: "relay-batch-done", display: true, content: `Background batch ${id} finished (${desc}):\n\n${body}` }, { deliverAs: "followUp", triggerTurn: true });
          } catch { /* session already gone */ }
        });
        touch();
        return text(`Started background batch ${id}: ${desc}. You will receive a completion message with the worker results; until then you are free to answer the user (relay_jobs list/tail shows live progress). Do not start the next pipeline step before it arrives.`);
      }
      const agents = loadAgents().filter((a) => a.name !== "relay");
      if (p.mode === "single" && p.tasks.length !== 1) return text("error: single mode needs exactly one task");
      if (pausedNow) return text("error: Relay is paused (/relay-pause). Do not launch workers; tell the user to run /relay-resume or ask you to resume.");
      {
        const { state: bst } = S.loadState(stateFile(cwd), schema("state"));
        const bp = bst ? (budgetProblem as any)(bst, budgetOf(cwd), p.tasks.length) : null;
        if (bp) return text(`error: budget exhausted: ${bp}. Stop and ask the user whether to raise relay.config.json budget.`);
      }
      const lp = (laneProblem as any)(p.tasks);
      if (lp) return text(`error: ${lp}`);
      let plan: any;
      const planPath = path.join(cwd, featureDir(), "plan.json");
      const needPlan = p.tasks.some((t: any) => t.agent === "relay-implementor");
      if (needPlan) {
        if (!fs.existsSync(planPath)) return text("error: plan.json missing");
        plan = readJson(planPath);
        const errs = [...validate(schema("plan"), plan), ...(validate(schema("plan"), plan).length ? [] : [...checkPlan(plan), ...(wsNames ? WS.checkWorkspacePlan(plan, wsNames) : [])])];
        if (errs.length) return text(`error: plan.json invalid:\n${errs.join("\n")}`);
      }
      if (wsNames && fs.existsSync(planPath)) {
        // reviewers/verifiers/fixers must see every repo the plan touches
        try { for (const r of readJson(planPath).repos || []) attachRepo(cwd, r); } catch (e: any) { return text(`error: ${e.message}`); }
      }
      if (p.mode === "parallel" && p.tasks.filter((t: any) => t.agent === "relay-implementor").length) {
        const slices = p.tasks.map((t: any) => t.slice);
        const wave = plan.order.find((w: string[]) => slices.every((s: string) => w.includes(s)));
        if (p.tasks.some((t: any) => t.agent !== "relay-implementor") || !wave || !plan.independence.parallelizable) {
          return text("error: parallel implementors only allowed for slices in the same wave of a plan.json that declares independence.parallelizable");
        }
      }

      const okSlices: Record<string, boolean> = {};
      const prev: string[] = [];
      const runTask = async (t: any, i: number) => {
        const agent = agents.find((a) => a.name === t.agent);
        if (!agent) return `error: unknown agent ${t.agent}. Available: ${agents.map((a) => a.name).join(", ")}`;
        // Tolerate bare names ("spec.md") and absolute paths; normalize to repo-relative.
        t.brief.inputs = t.brief.inputs.map((f: string) => {
          for (const c of [path.resolve(cwd, f), path.resolve(cwd, featureDir(), f), path.resolve(cwd, featureDir(), path.basename(f))]) {
            if (fs.existsSync(c)) return posix(path.relative(cwd, c));
          }
          return f;
        });
        const missing = t.brief.inputs.filter((f: string) => !fs.existsSync(path.resolve(cwd, f)));
        if (missing.length) return `error: input files missing: ${missing.join(", ")}. Paths are relative to the worktree root, e.g. ${featureDir()}/spec.md`;
        let ownedGlobs: string[] = [];
        if (t.agent === "relay-implementor") {
          const sl = plan.slices.find((s: any) => s.id === t.slice);
          if (!sl) return `error: unknown slice ${t.slice}. Set task.slice to one of: ${plan.slices.map((s: any) => s.id).join(", ")}`;
          ownedGlobs = [...sl.files.own, ...(sl.tests || [])];
        }
        const lf = path.join(cwd, ".ai", "lessons.md");
        const lessons = fs.existsSync(lf) ? lessonsFor(fs.readFileSync(lf, "utf8"), t.agent) : [];
        const sub = (s: string) => s.replaceAll("{previous}", prev[i - 1] ?? "");
        const b = t.brief;
        const required = requiredOutputs(t.agent, featureDir(), t.slice, t.lane);
        const task = [
          `## Objective\n${sub(b.objective)}`,
          `## Output format\n${sub(b.outputFormat)}`,
          `## Tools and sources\n${sub(b.guidance)}`,
          `## Boundaries\n${sub(b.boundaries)}`,
          `## Inputs (read in full)\n${b.inputs.map((f: string) => `- ${f}`).join("\n")}`,
          `## Lessons for your role\n${lessons.map((l: any) => `- ${l.symptom} => ${l.rule}`).join("\n") || "(none)"}`,
          required.length ? `## Required output files (authoritative; override any other file names above)\nWrite exactly these files with the write tool, relative to the working directory:\n${required.map((f) => `- ${f}`).join("\n")}\nThe task is not done until each exists on disk.` : "",
          t.agent === "relay-spec-writer" ? `## holdout/scenarios.json (hidden from implementors and reviewer; only the verifier will read it) must validate against this JSON Schema: at least 3 end-to-end behavioural user stories that are DIFFERENT from the visible features.json scenarios (cover edge cases, error paths and cross-feature flows; do not restate visible scenarios)\n\`\`\`json\n${JSON.stringify(schema("holdout"))}\n\`\`\`` : "",
          t.agent === "relay-verifier" && configOf(cwd).verifier?.shot ? `## Browser tooling (installed by /relay-init)\nFor browser UIs use Playwright via the pre-installed helper (absolute paths; the tools dir is not inside feature worktrees): node ${path.join(cwd, configOf(cwd).verifier.shot)} <url> <out.png>. For custom flows, write scripts under verify-tools/ that import from ${path.join(cwd, configOf(cwd).verifier.tools || ".relay/tools", "node_modules", "playwright")}. Save screenshots as evidence files.` : "",
          t.agent === "relay-verifier" ? `## holdout/results.json: after running every scenario in holdout/scenarios.json black-box, write holdout/results.json (schema below) with one result per scenario; pass requires non-empty evidence files; list each evidence path in 'evidence' relative to the repo/worktree root, i.e. ${featureDir()}/holdout/evidence/<file>. On failure set 'symptom' to a one-line observed behaviour (no steps; the orchestrator relays it to implementors).\n\`\`\`json\n${JSON.stringify(schema("holdout-results"))}\n\`\`\`` : "",
          t.agent === "relay-architect" ? `## plan.json must validate against this JSON Schema exactly (no extra properties; slice ids kebab-case; contracts are objects {name,pinned,location}; slice.contracts are strings; slices need dependsOn; every slice that changes code lists its test file(s) in slice.tests; slices in the SAME wave of order must have completely disjoint files.own (if two slices touch the same file, put them in separate waves, one slice per wave, in dependency order) and a wave with 2+ slices requires independence.parallelizable=true, otherwise use one slice per wave; top-level needs contracts, slices, order (array of arrays of slice ids), independence)\n\`\`\`json\n${JSON.stringify(schema("plan"))}\n\`\`\`` : "",
          t.agent === "relay-reviewer" && t.lane ? `## Review lens: ${t.lane}\nReview ONLY through this lens. Checklist: ${(LENS_CHECKLISTS as any)[t.lane] || "apply the lens named above"}.\nWrite ${featureDir()}/reports/review-${t.lane}.json (JSON only, no markdown) validating against this schema with lens="${t.lane}". Every finding needs a citation "path:line" (e.g. src/app.js:42) or it is dropped. severity blocker/major = must fix before PR; minor = advisory. Use an empty findings array if clean.\n\`\`\`json\n${JSON.stringify(schema("review-lens"))}\n\`\`\`` : "",
          t.agent === "relay-doc-reviewer" && t.lane ? (() => { const li: any = DR.laneInfo(t.lane); if (!li) return ""; return `## Document review: ${li.doc} through the "${li.lens}" lens\nDocument under review (read in full): ${DR.docFiles(li.doc).map((n: string) => `${featureDir()}/${n}`).join(", ")}${li.doc === "design" ? `; the approved spec ${featureDir()}/spec.md is the referenced context` : ""}.\nChecklist: ${(DR.DOC_LENS_CHECKLISTS as any)[li.lens]}\nWrite ${featureDir()}/reports/docreview-${t.lane}.json (JSON only) with doc="${li.doc}", lens="${li.lens}"${li.lens === "comprehension" ? ", and a real \"paraphrase\" of what the document says" : ""}. Each finding: severity (blocker/major/minor), scope (section heading or path:line), title, rationale, recommendation. Use an empty findings array if clean. You see only the document, never the conversation.\n\`\`\`json\n${JSON.stringify(schema("docreview-lens"))}\n\`\`\``; })() : "",
          t.agent === "relay-researcher" && t.lane ? `## Research topic: ${t.lane}\nCover ONLY this topic; other researchers cover the rest in parallel. Write ${featureDir()}/research-${t.lane}.md. Every claim cites path:line.` : "",
          t.agent === "relay-verifier" && wsNames && Object.keys(readJson(stateFile(cwd)).workspace?.repos || {}).length > 1 ? `## Cross-repo verification (required)\nThis feature changes ${Object.keys(readJson(stateFile(cwd)).workspace.repos).join(" + ")}. Besides per-repo checks, run at least one scenario end to end ACROSS the repos: start the producing service from its worktree (${Object.keys(readJson(stateFile(cwd)).workspace.repos).join(", ")} are directories in your cwd; producers before consumers, ephemeral or free ports, never a port already in use), then drive the consuming repo's real client/UI against it over real HTTP/IPC. Use each repo's run command from its AGENTS.md (a worktree has no node_modules: install into a sandbox or reuse the main checkout's, and record it in toolsInstalled). Always stop what you started. Save the evidence as evidence/xrepo-<scenario>.json (or .png/.log) including each repo's HEAD sha, the command lines, ports and the raw request/response. If the services cannot be run together, mark those scenarios blocked with the reason; do not substitute mocks and call it cross-repo.` : "",
          wsNames ? `## Workspace (multi-repo) feature\nYour working directory is the feature container; each repo is a git worktree directory inside it: ${wsNames.join(", ")} (only repos the plan touches exist there). Every path is repo-qualified, e.g. ${wsNames[0]}/src/x.js. Main checkouts (read-only reference for research/design) are at ${wsMark.root}${path.sep}<repo>. Implementors: change files ONLY inside your slice's repo dir and commit inside that repo dir (git -C <repo> ...). Never commit at the container root.` : "",
          `Feature dir: ${featureDir()}${t.slice ? `\nSlice: ${t.slice}` : ""}${t.lane ? `\nLane: ${t.lane}` : ""}`,
        ].filter(Boolean).join("\n\n");
        if (t.step) withState(cwd, (st: any) => S.beginStep(st, t.step, { agent: t.agent, inputs: b.inputs }));
        if (t.slice) withState(cwd, (st: any) => { st.slices[t.slice] = { ...(st.slices[t.slice] || {}), status: "running" }; });
        const planProblems = () => {
          if (t.agent !== "relay-architect") return [] as string[];
          try {
            const pl = JSON.parse(fs.readFileSync(path.join(cwd, featureDir(), "plan.json"), "utf8"));
            const e = validate(schema("plan"), pl);
            if (e.length) return e;
            const cp = [...checkPlan(pl), ...(wsNames ? WS.checkWorkspacePlan(pl, wsNames) : [])];
            if (cp.length) return cp;
            return pl.slices.flatMap((s: any) => testGate([...s.files.own, ...(s.tests || [])]).map(() => `slice ${s.id}: owns code but lists no test file; add its test file(s) (e.g. test/<name>.test.js) to slice.tests`));
          } catch (e: any) { return [`plan.json unreadable: ${e.message}`]; }
        };
        if (wsNames && t.agent === "relay-implementor" && !t.__wt) {
          try { attachRepo(cwd, plan.slices.find((s: any) => s.id === t.slice).repo); } catch (e: any) { return `error: ${e.message}`; }
        }
        const wcwd: string = t.__wt || cwd;
        const taskHead = safe(() => git(wcwd, "rev-parse", "HEAD"));
        const taskHeads: Record<string, string> = wsNames ? WS.snapshotHeads(wcwd, wsNames) : {};
        const reverted: string[] = [];
        const allowedFile = (f: string) => f.startsWith(".ai/") || matchesAny(ownedGlobs, f);
        const testProblems = () => {
          if (t.agent !== "relay-implementor") return [] as string[];
          const ch = wsNames ? WS.changedSinceRepos(wcwd, taskHeads) : changedSince(wcwd, taskHead);
          return testGate([...ch].filter((f: string) => matchesAny(ownedGlobs, f)));
        };
        const scoutProblemsFn = () => {
          if (t.agent !== "relay-repo-scout" || !required.every((f) => fs.existsSync(path.join(wcwd, f)))) return [] as string[];
          let report: any = null;
          try { report = JSON.parse(fs.readFileSync(path.join(wcwd, featureDir(), "scout-report.json"), "utf8")); } catch { /* reported below */ }
          return I.scoutProblems({ report, draft: fs.readFileSync(path.join(wcwd, featureDir(), "agents-draft.md"), "utf8"), cwd: wcwd }) as string[];
        };
        const problems = () => {
          if (wsNames) reverted.push(...WS.enforceOwnershipRepos(wcwd, taskHeads, allowedFile));
          else if (taskHead) reverted.push(...(enforceOwnership as any)(wcwd, taskHead, allowedFile).reverted);
          return [
            ...testProblems(),
            ...required.filter((f) => !fs.existsSync(path.join(wcwd, f))).map((f) => `missing output ${f}`),
            ...scoutProblemsFn(),
            ...(required.every((f) => fs.existsSync(path.join(wcwd, f))) ? planProblems() : []),
          ];
        };
        const tj = trackJob(cwd, t, agent);
        let r = await runAgent({
          cwd: wcwd, agent, task, signal, ...tj.hooks(1),
          env: { RELAY_ROLE: agent.name, RELAY_FEATURE: slug!, RELAY_OWNED: JSON.stringify(ownedGlobs) },
        });
        let probs = problems();
        for (let attempt = 0; attempt < 2 && r.exitCode === 0 && probs.length; attempt++) {
          // automatic retries with concrete feedback
          r = await runAgent({
            cwd: wcwd, agent, signal, ...tj.hooks(attempt + 2, probs[0]),
            task: `${task}\n\n## Previous attempt failed validation. Fix exactly this and write the files to disk:\n${probs.map((x) => `- ${x}`).join("\n")}`,
            env: { RELAY_ROLE: agent.name, RELAY_FEATURE: slug!, RELAY_OWNED: JSON.stringify(ownedGlobs) },
          });
          probs = problems();
        }
        withState(cwd, (st: any) => { (addUsage as any)(st, agent.name, r); return "usage"; });
        const ranOk = r.exitCode === 0 && r.stopReason !== "error";
        const absent = probs;
        const ok = ranOk && absent.length === 0;
        tj.finish(signal?.aborted ? "cancelled" : ok ? "done" : "failed");
        if (signal?.aborted) {
          // cancelled mid-run: nothing is half-recorded; the step/slice is re-runnable
          withState(cwd, (st: any) => { if (t.step) S.finishStep(st, t.step, { status: "interrupted", outputs: [], error: "cancelled" }); if (t.slice) st.slices[t.slice] = { ...(st.slices[t.slice] || {}), status: "interrupted" }; return "cancelled"; });
          return `### ${t.agent}${t.slice ? ` (${t.slice})` : ""} CANCELLED (interrupted; re-run it)`;
        }
        if (t.agent === "relay-implementor") {
          const srepo: string | undefined = wsNames ? plan.slices.find((s: any) => s.id === t.slice).repo : undefined;
          if (wsNames) (WS.commitSliceLeftoversWs as any)(wcwd, t.slice, srepo, featureDir());
          else (commitSliceLeftovers as any)(wcwd, t.slice, featureDir());
          okSlices[t.slice] = ok;
          if (!t.__wt) withState(cwd, (st: any) => { st.slices[t.slice] = ok ? { status: "merged", commit: safe(() => git(srepo ? path.join(cwd, srepo) : cwd, "rev-parse", "HEAD")), ...(srepo ? { repo: srepo } : {}) } : { status: "failed", ...(srepo ? { repo: srepo } : {}) }; });
        }
        if (t.step) {
          const outs = Array.from(new Set([...(t.outputs || []), ...required]));
          const outputs = outs.filter((f: string) => fs.existsSync(path.join(wcwd, f)))
            .map((f: string) => ({ path: posix(f), sha256: S.sha256File(path.join(wcwd, f)) }));
          withState(cwd, (st: any) => S.finishStep(st, t.step, { status: ok ? "done" : "failed", outputs, error: ok ? undefined : (absent.length ? `missing outputs: ${absent.join(", ")}` : r.errorMessage || r.stderr.slice(-500)) }));
        }
        prev[i] = r.output;
        const missNote = absent.length ? `\nMISSING REQUIRED OUTPUTS: ${absent.join(", ")}. Re-run this worker; do not proceed.` : "";
        const xrepoNote = (t.agent === "relay-verifier" && wsNames && Object.keys(readJson(stateFile(cwd)).workspace?.repos || {}).length > 1 && !(fs.existsSync(path.join(wcwd, featureDir(), "evidence")) && fs.readdirSync(path.join(wcwd, featureDir(), "evidence")).some((n: string) => /^xrepo-/.test(n)))) ? `\nNO CROSS-REPO EVIDENCE: no evidence/xrepo-* file. Re-run the verifier with an explicit cross-repo scenario, or accept it only with a recorded blocked reason.` : "";        const revNote = reverted.length ? `\nHARNESS REVERTED out-of-ownership changes: ${[...new Set(reverted)].join(", ")}` : "";
        return `### ${t.agent}${t.slice ? ` (${t.slice})` : ""} exit=${r.exitCode}${ok ? "" : " FAILED"}\n${r.output || r.stderr.slice(-800)}${missNote}${revNote}${xrepoNote}`;
      };

      // Parallel implementors each get their own worktree (sub-branch of the feature branch).
      const useSliceWt = p.mode === "parallel" && p.tasks.filter((t: any) => t.agent === "relay-implementor").length > 1;
      let preface = "";
      if (useSliceWt) {
        const cp = (commitArtefacts as any)(cwd, featureDir(), `relay: checkpoint ${slug} artefacts before parallel slices`);
        if (!cp.ok) return text(`error: cannot checkpoint artefacts for slice worktrees: ${cp.error}`);
        for (const t of p.tasks) {
          try {
            const srepo = wsNames ? plan.slices.find((s: any) => s.id === t.slice).repo : undefined;
            if (srepo) attachRepo(cwd, srepo);
            t.__wt = srepo ? WS.addSliceWorktreeWs(cwd, slug!, t.slice, srepo).path : (addSliceWorktree as any)(cwd, slug, t.slice).path;
          }
          catch (e: any) { return text(`error: cannot create worktree for slice ${t.slice}: ${e.message}`); }
          withState(cwd, (st: any) => { st.slices[t.slice] = { status: "running", worktree: t.__wt }; });
        }
      }

      onStarted?.();
      let results: string[];
      if (p.mode === "chain") { results = []; for (let i = 0; i < p.tasks.length; i++) results.push(await runTask(p.tasks[i], i)); }
      else results = await mapLimit<any, string>(p.tasks, 4, runTask);

      if (useSliceWt) {
        const order: string[] = plan.order.flat().filter((s: string) => p.tasks.some((t: any) => t.slice === s && okSlices[s]));
        const repoOf = (s: string) => plan.slices.find((x: any) => x.id === s)?.repo;
        const { merged, conflicts } = wsNames
          ? WS.mergeSlicesWs(cwd, slug!, order.map((s) => ({ slice: s, repo: repoOf(s) })))
          : (mergeSlices as any)(cwd, slug, order);
        for (const m of merged) {
          withState(cwd, (st: any) => { st.slices[m.slice] = { status: "merged", commit: m.commit, ...(wsNames ? { repo: repoOf(m.slice) } : {}) }; });
          if (wsNames) WS.removeSliceWorktreeWs(cwd, slug!, m.slice, repoOf(m.slice), { deleteBranch: true });
          (removeSliceWorktree as any)(cwd, slug, m.slice, { deleteBranch: true });
        }
        for (const c of conflicts) withState(cwd, (st: any) => { st.slices[c.slice] = { status: "failed", worktree: p.tasks.find((t: any) => t.slice === c.slice)?.__wt }; });
        for (const t of p.tasks) if (!okSlices[t.slice]) withState(cwd, (st: any) => { st.slices[t.slice] = { status: "failed", worktree: t.__wt }; });
        preface = `SLICE MERGE (deterministic plan order): merged=[${merged.map((m: any) => m.slice).join(", ")}]` +
          (conflicts.length ? `; CONFLICTS (merge aborted, branch relay/${slug}--<slice> and worktree kept): ${conflicts.map((c: any) => `${c.slice}[${c.files.join(", ")}]`).join("; ")}. Re-delegate the conflicting slice sequentially (single mode) after fixing the plan's file ownership.` : "") +
          (p.tasks.some((t: any) => !okSlices[t.slice]) ? `; failed slices (not merged, worktrees kept): ${p.tasks.filter((t: any) => !okSlices[t.slice]).map((t: any) => t.slice).join(", ")}` : "") + "\n\n";
      }

      const strays: string[] = (quarantineStrays as any)(cwd, featureDir());
      const strayNote = strays.length ? `\n\nSTRAY FILES moved to ${featureDir()}/_quarantine/ (not in the allowed artefact layout): ${strays.join(", ")}` : "";
      return text(preface + results.join("\n\n") + strayNote);
    },
  };
  pi.registerTool(subagentTool);

  // ---- Live status UI, worker registry, background batches ----
  const batches = new Map<string, { ac: AbortController; desc: string; hasImpl: boolean; startedAt: number }>();
  let uiCtx: any;
  let pausedNow = false;
  let view: { slug: string; root: string } | undefined; // unfinished feature found on disk (display only; does not activate guards)
  let lastKey = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  let jobSeq = 0;
  const target = () => (slug ? { slug, root: root ?? uiCtx?.cwd ?? process.cwd() } : view);

  const refresh = () => {
    try {
      if (!uiCtx?.hasUI) return;
      const t = target();
      if (!t) return;
      const { state } = S.loadState(path.join(t.root, ".ai", t.slug, "state.json"), schema("state"));
      if (!state) return;
      let plan: any = null;
      try { plan = readJson(path.join(t.root, ".ai", t.slug, "plan.json")); } catch { /* no plan yet */ }
      const jobs = reconcileJobs(readJobs(runtimeDir(t.root, t.slug)));
      const snap = buildSnapshot({ state, plan, jobs });
      const w = Math.max(40, (process.stdout.columns || 100) - 2);
      const top = renderTop(snap, w, { color: !process.env.NO_COLOR }), bottom = renderBottom(snap, w, { color: !process.env.NO_COLOR, maxRows: Math.max(3, (process.stdout.rows || 30) - 22) });
      const key = JSON.stringify([top, bottom]);
      if (key === lastKey) return;
      lastKey = key;
      uiCtx.ui.setWidget("relay-pipeline", top);
      uiCtx.ui.setWidget("relay-steps", bottom, { placement: "belowEditor" });
      uiCtx.ui.setStatus("relay", `relay ${snap.phase}${snap.running ? ` ●${snap.running}` : ""}`);
    } catch { /* the status UI must never break the run */ }
  };
  let pending: ReturnType<typeof setTimeout> | undefined;
  const touch = () => { if (!pending) pending = setTimeout(() => { pending = undefined; refresh(); }, 250); };

  // One job record per worker invocation (retries reuse it); persisted in the worktree's git dir.
  const trackJob = (cwd: string, t: any, agent: any) => {
    const dir = runtimeDir(cwd, slug!);
    const id = `${Date.now().toString(36)}${(jobSeq++).toString(36)}-${agent.name.replace(/^relay-/, "")}`;
    const logFile = path.join(dir, "logs", `${id}.jsonl`);
    let phase = "";
    try { phase = readJson(stateFile(cwd)).phase; } catch { /* ignore */ }
    let job: any = {
      id, agent: agent.name, label: [agent.name.replace(/^relay-/, ""), t.lane || t.slice].filter(Boolean).join(":"),
      phase, step: t.step, slice: t.slice, lane: t.lane, log: logFile, status: "running", startedAt: Date.now(), tools: 0, tokens: 0, turns: 0, attempt: 1,
    };
    let lastWrite = 0;
    const save = () => { try { upsertJob(dir, job); } catch { /* best effort */ } touch(); };
    return {
      hooks(attempt: number, why?: string) {
        job = { ...job, status: "running", attempt, endedAt: undefined };
        if (attempt > 1) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, JSON.stringify({ type: "relay_marker", text: `attempt ${attempt}: previous output failed validation: ${String(why).slice(0, 160)}` }) + "\n"); } catch { /* ignore */ } }
        save();
        return {
          logFile,
          onSpawn: (pid: number) => { job = { ...job, pid }; save(); },
          onEvent: (ev: any) => { job = applyEvent(job, ev); if (Date.now() - lastWrite > 400) { lastWrite = Date.now(); save(); } },
        };
      },
      finish(status: string) { job = { ...job, status, endedAt: Date.now() }; save(); },
    };
  };

  const startUi = (ctx: any) => {
    uiCtx = ctx;
    if (!ctx.hasUI) return;
    try {
      let roots: string[];
      try { roots = (listWorktrees(ctx.cwd) as any[]).map((w) => w.path); } catch { roots = [ctx.cwd]; } // non-git workspace parent
      const open = (discoverFeatures(roots) as any[]).find((f) => f.phase !== "done");
      if (open) view = { slug: open.slug, root: open.root };
    } catch { /* not a git repo */ }
    lastKey = "";
    refresh();
    if (!timer) { timer = setInterval(refresh, 1000); (timer as any).unref?.(); }
  };
  pi.on("session_start", async (_e: any, ctx: any) => { startUi(ctx); });
  pi.on("session_shutdown", async () => {
    if (timer) { clearInterval(timer); timer = undefined; }
    for (const b of batches.values()) b.ac.abort();
  });

  const openWatch = async (ctx: any, focus?: string) => {
    uiCtx = ctx;
    const t = target();
    if (!t || !ctx.hasUI) { ctx.ui?.notify?.("No active Relay feature to watch", "info"); return; }
    const dir = runtimeDir(t.root, t.slug);
    await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (v: undefined) => void) => new WatchView(tui, theme, dir, done, focus), {
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "95%", anchor: "top-left", margin: 0 },
    });
  };
  pi.registerShortcut("alt+w", { description: "Relay: watch worker sessions (esc returns to the orchestrator)", handler: (ctx: any) => openWatch(ctx) });
  pi.registerCommand("relay-watch", {
    description: "Live read-only view of Relay worker sessions: /relay-watch [worker]",
    handler: async (args: string, ctx: any) => { await openWatch(ctx, args.trim() || undefined); },
  });

  pi.registerTool({
    name: "relay_jobs",
    label: "Relay jobs",
    description: "Inspect or cancel Relay workers. list: all worker sessions with status; tail: last lines of one worker's live output (id or label e.g. implementor:api); cancel: abort a background batch by id (see relay_subagent background).",
    promptSnippet: "Check progress of running Relay workers (use this to answer user questions mid-run)",
    parameters: Type.Object({
      action: StringEnum(["list", "tail", "cancel"] as const),
      id: Type.Optional(Type.String()),
      lines: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
      if (!slug) return text("error: no active feature");
      const dir = runtimeDir(rootOf(ctx), slug);
      const jobs = reconcileJobs(readJobs(dir));
      if (p.action === "list") {
        const rows = jobs.map((j: any) => `${j.id}  ${j.label}  ${j.status}  phase=${j.phase}  ${Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000)}s  tools=${j.tools} tokens=${j.tokens}${j.status === "running" && j.last ? `  now: ${j.last}` : ""}`);
        const bs = [...batches.entries()].map(([id, b]) => `batch ${id}: ${b.desc} (running ${Math.round((Date.now() - b.startedAt) / 1000)}s)`);
        return text([...bs, ...rows].join("\n") || "no workers yet");
      }
      if (p.action === "tail") {
        const j = jobs.find((x: any) => x.id === p.id || x.label === p.id) || [...jobs].reverse().find((x: any) => x.status === "running");
        if (!j) return text("no matching worker");
        const ls = (readLogLines(j.log) as string[]).slice(-(p.lines || 30));
        return text(`${j.label} [${j.status}]\n${ls.join("\n") || "(no output yet)"}`);
      }
      const b = batches.get(String(p.id));
      if (!b) return text(`no running background batch ${p.id}`);
      b.ac.abort();
      return text(`cancelling batch ${p.id}; its completion message will report what finished`);
    },
  });

  const pauseRun = (ctx: any, reason = "paused by user") => {
    if (!slug) return "No active Relay feature to pause";
    pausedNow = true;
    const inFlight = [...batches.values()].map((b) => b.desc);
    const dir = runtimeDir(rootOf(ctx), slug);
    const running = (reconcileJobs(readJobs(dir)) as any[]).filter((j) => j.status === "running").map((j) => j.label);
    for (const b of batches.values()) b.ac.abort();
    const sf = stateFile(rootOf(ctx));
    withState(rootOf(ctx), (st: any) => { S.pauseState(st, { reason, inFlight: [...new Set([...inFlight, ...running])] }); return "paused"; });
    // foreground workers cannot be cancelled from a command; the pause takes effect before the next launch
    touch();
    return `Paused ${slug}. In flight: ${[...new Set([...inFlight, ...running])].join(", ") || "nothing"}. Background workers are being stopped; no new workers will start. Use /relay-resume to continue.`;
  };
  pi.registerCommand("relay-pause", {
    description: "Gracefully pause the Relay run: stop launching workers, cancel running background ones, record what was in flight",
    handler: async (args: string, ctx: any) => { ctx.ui.notify(pauseRun(ctx, args.trim() || "paused by user"), "info"); },
  });
  pi.registerCommand("relay-resume", {
    description: "Resume a paused Relay run (the orchestrator re-opens it, re-runs interrupted workers)",
    handler: async (_args: string, ctx: any) => {
      if (!slug) { ctx.ui.notify("No active Relay feature; start pi and say: relay --resume <slug>", "info"); return; }
      pausedNow = false;
      try { withState(rootOf(ctx), (st: any) => { delete st.paused; return "resumed"; }); } catch { /* state unreadable; open will repair */ }
      pi.sendUserMessage(`Resume the paused feature ${slug}: call harness_state open (slug ${slug}), read its report, re-run every interrupted step/slice, then continue the pipeline.`);
    },
  });
  pi.registerCommand("relay-init", {
    description: "Prepare this repo for Relay: scout it, draft AGENTS.md, configure checks and verifier tooling (asks before writing/installing). --refresh to redo.",
    handler: async (args: string, _ctx: any) => {
      const refresh = /--refresh/.test(args);
      pi.sendUserMessage(`Run the Relay init flow${refresh ? " in refresh mode" : ""} as described in skills/relay/references/init.md (relay_init tool). Do not start a feature.`);
    },
  });
  pi.registerCommand("relay-status", {
    description: "Show the active Relay feature state",
    handler: async (_args: string, ctx: any) => {
      if (!slug) { ctx.ui.notify("No active Relay feature", "info"); return; }
      const st = readJson(stateFile(rootOf(ctx)));
      const steps = Object.entries<any>(st.steps).map(([k, v]) => `${k}:${v.status}`).join(" ");
      ctx.ui.notify(`${st.slug} phase=${st.phase} ${steps}`, "info");
    },
  });
}

function safe(fn: () => string): string {
  try { return fn(); } catch { return ""; }
}

