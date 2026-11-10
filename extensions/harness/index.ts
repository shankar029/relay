import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
// @ts-ignore plain ESM helpers (see lib/)
import { validate } from "../../lib/jsonschema.mjs";
// @ts-ignore
import { checkWrite, matchesAny, requiredOutputs, phaseRequires } from "../../lib/policy.mjs";
// @ts-ignore
import * as S_ from "../../lib/state.mjs";
// @ts-ignore
import { checkPlan } from "../../lib/plan.mjs";
// @ts-ignore
import { lessonsFor, addLesson } from "../../lib/lessons.mjs";
// @ts-ignore
import { scanText, maskText } from "../../lib/secrets.mjs";
// @ts-ignore
import { ensureWorktree, findWorktree, excludeHarnessFiles, branchFor, repoTop } from "../../lib/worktree.mjs";
const S: any = S_;
import { RELAY_HOME, loadAgents, runAgent, mapLimit } from "./run.ts";

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const schema = (n: string) => readJson(path.join(RELAY_HOME, "schemas", `${n}.schema.json`));
const text = (t: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text: t }], details });
const posix = (p: string) => p.split(path.sep).join("/");

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
    if (event.toolName === "read" && /(^|[\\/])README\.md$/i.test(String(input.path || ""))) {
      if (!["relay-researcher", "relay-architect"].includes(role)) {
        return { block: true, reason: "relay guard: only researcher and architect may read README.md" };
      }
    }
    if (event.toolName === "bash") {
      const cmd = String(input.command || "");
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
      "Read/modify .ai/<slug>/state.json safely (atomic, schema-validated). Actions: init, open, get, set_phase, step, counter, approval (only 'pending'), slice, checks, question, answer, artifact, lesson_add, lessons_for, unlock.",
    promptSnippet: "Change Relay run state (never edit state.json by hand)",
    parameters: Type.Object({
      action: StringEnum(["init", "open", "get", "set_phase", "step", "counter", "approval", "slice", "checks", "question", "answer", "artifact", "lesson_add", "lessons_for", "unlock"] as const),
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
    }),
    async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
      const repoCwd = ctx.cwd || process.cwd();
      let cwd = rootOf(ctx);
      const lock = () => path.join(cwd, featureDir(), ".lock");
      try {
        if (p.action === "init") {
          if (!p.slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug)) return text("error: slug must be kebab-case");
          if (!p.requirement) return text("error: requirement required");
          let wt: any;
          if (p.worktree !== false) {
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
          S.saveState(stateFile(cwd), S.newState({ slug, requirement: p.requirement, worktree }), schema("state"));
          const lessons = path.join(cwd, ".ai", "lessons.md");
          if (!fs.existsSync(lessons)) fs.copyFileSync(path.join(RELAY_HOME, "templates", "lessons.md"), lessons);
          return text(wt
            ? `initialised ${featureDir()} in worktree ${wt.path} (branch ${wt.branch}, ${wt.created ? "created" : "re-attached"}). ALL work happens there: use absolute paths under ${wt.path} for every write/read of feature files.`
            : `initialised ${featureDir()} in place (no worktree) at ${cwd}`);
        }
        if (p.action === "open") {
          slug = p.slug;
          if (!slug) return text("error: slug required");
          const found = p.worktree === false ? undefined : (() => { try { return findWorktree(repoCwd, slug); } catch { return undefined; } })();
          cwd = found ? found.path : repoCwd;
          if (!fs.existsSync(stateFile(cwd))) { slug = undefined; return text(`error: no .ai/${p.slug}/state.json in ${cwd}${found ? "" : ` (no worktree on branch ${branchFor(p.slug)} found)`}`); }
          root = cwd;
          const lk = S.acquireLock(lock(), { takeover: !!p.takeover });
          if (!lk.ok) { slug = undefined; root = undefined; return text(`lock held by pid ${lk.pid} since ${lk.timestamp} (stale=${lk.stale}). If stale, confirm with the user and retry with takeover=true.`); }
          if (found) excludeHarnessFiles(found.path);
          const { state, errors } = S.loadState(stateFile(cwd), schema("state"));
          if (!state) return text(`state.json corrupt/invalid: ${errors.join("; ")}. Re-run the producing step.`);
          const report: any = { phase: state.phase, worktree: state.worktree ? { ...state.worktree, path: cwd } : null, hashMismatches: S.verifyArtifacts(state, cwd), runningSteps: [], missingCommits: [], pendingQuestions: state.pendingQuestions, pendingApprovals: [] };
          for (const [id, s] of Object.entries<any>(state.steps)) if (s.status === "running") report.runningSteps.push(id);
          for (const [id, s] of Object.entries<any>(state.slices)) {
            if (s.status !== "merged" || !s.commit) continue;
            try { git(cwd, "merge-base", "--is-ancestor", s.commit, "HEAD"); } catch { report.missingCommits.push(id); }
          }
          for (const [n, v] of Object.entries(state.approvals)) if (v === "pending") report.pendingApprovals.push(n);
          try { report.dirty = git(cwd, "status", "--porcelain").split("\n").filter(Boolean); } catch { report.dirty = ["(git unavailable)"]; }
          return text(JSON.stringify(report, null, 2), report);
        }
        if (!slug) return text("error: no active feature; call init or open first");
        if (p.action === "get") return text(fs.readFileSync(stateFile(cwd), "utf8"));
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
              {
                const miss = phaseRequires(p.phase, featureDir()).filter((f: string) => !fs.existsSync(path.join(cwd, f)));
                if (miss.length) throw new Error(`cannot enter ${p.phase}: missing ${miss.join(", ")}. Re-run the producing worker.`);
              }
              st.phase = p.phase; return `phase=${p.phase}`;
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
        return text(String(out));
      } catch (e: any) {
        return text(`error: ${e.message}`);
      }
    },
  });

  pi.registerTool({
    name: "relay_approval",
    label: "User approval",
    description: "Ask the user to approve a gate (e.g. spec, design). The only way an approval becomes approved/rejected. Needs an interactive UI.",
    parameters: Type.Object({ name: Type.String(), message: Type.String({ description: "what is being approved and where to read it" }) }),
    async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
      if (!slug) return text("error: no active feature");
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
      let checks = (readJson(stateFile(cwd)).checks || {}) as Record<string, string>;
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
      for (const name of ["build", "typecheck", "lint", "test"]) {
        if (!checks[name] || (p.only && !p.only.includes(name))) continue;
        const r = spawnSync(checks[name], { cwd, shell: true, encoding: "utf8", timeout: 10 * 60_000 });
        const ok = r.status === 0;
        allOk = allOk && ok;
        const log = maskText(`$ ${checks[name]}\n${r.stdout}\n${r.stderr}`);
        const logRel = `${featureDir()}/evidence/checks-${name}-${Date.now()}.log`;
        S.writeFileAtomic(path.join(cwd, logRel), log.slice(-20000));
        rows.push(`${ok ? "PASS" : "FAIL"} ${name} (${logRel})${ok ? "" : "\n" + log.slice(-1500)}`);
      }
      return text(`${allOk && rows.length ? "ALL GREEN" : rows.length ? "RED" : "NO CHECKS CONFIGURED: not green. Set them with harness_state action=checks (commands: {build,typecheck,lint,test})"}\n${rows.join("\n")}`);
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
    outputs: Type.Optional(Type.Array(Type.String(), { description: "expected output files, hashed into state on success" })),
  });

  pi.registerTool({
    name: "relay_subagent",
    label: "Relay sub-agent",
    description: "Run relay-* worker agents as isolated pi processes. mode: single (1 task), parallel (read-only agents, or implementors only if plan.json proves independence), chain (sequential; {previous} in later brief fields is replaced by prior output).",
    promptSnippet: "Delegate to a relay-* worker agent with a structured brief",
    parameters: Type.Object({
      mode: StringEnum(["single", "parallel", "chain"] as const),
      tasks: Type.Array(TaskSchema, { minItems: 1 }),
    }),
    async execute(_id: string, p: any, signal: any, _u: any, ctx: any) {
      if (!slug) return text("error: no active feature; call harness_state init/open first");
      const cwd = rootOf(ctx);
      const agents = loadAgents().filter((a) => a.name !== "relay");
      if (p.mode === "single" && p.tasks.length !== 1) return text("error: single mode needs exactly one task");

      let plan: any;
      const planPath = path.join(cwd, featureDir(), "plan.json");
      const needPlan = p.tasks.some((t: any) => t.agent === "relay-implementor");
      if (needPlan) {
        if (!fs.existsSync(planPath)) return text("error: plan.json missing");
        plan = readJson(planPath);
        const errs = [...validate(schema("plan"), plan), ...(validate(schema("plan"), plan).length ? [] : checkPlan(plan))];
        if (errs.length) return text(`error: plan.json invalid:\n${errs.join("\n")}`);
      }
      if (p.mode === "parallel" && p.tasks.filter((t: any) => t.agent === "relay-implementor").length) {
        const slices = p.tasks.map((t: any) => t.slice);
        const wave = plan.order.find((w: string[]) => slices.every((s: string) => w.includes(s)));
        if (p.tasks.some((t: any) => t.agent !== "relay-implementor") || !wave || !plan.independence.parallelizable) {
          return text("error: parallel implementors only allowed for slices in the same wave of a plan.json that declares independence.parallelizable");
        }
      }

      const headBefore = needPlan ? safe(() => git(cwd, "rev-parse", "HEAD")) : "";
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
          ownedGlobs = sl.files.own;
        }
        const lf = path.join(cwd, ".ai", "lessons.md");
        const lessons = fs.existsSync(lf) ? lessonsFor(fs.readFileSync(lf, "utf8"), t.agent) : [];
        const sub = (s: string) => s.replaceAll("{previous}", prev[i - 1] ?? "");
        const b = t.brief;
        const required = requiredOutputs(t.agent, featureDir(), t.slice);
        const task = [
          `## Objective\n${sub(b.objective)}`,
          `## Output format\n${sub(b.outputFormat)}`,
          `## Tools and sources\n${sub(b.guidance)}`,
          `## Boundaries\n${sub(b.boundaries)}`,
          `## Inputs (read in full)\n${b.inputs.map((f: string) => `- ${f}`).join("\n")}`,
          `## Lessons for your role\n${lessons.map((l: any) => `- ${l.symptom} => ${l.rule}`).join("\n") || "(none)"}`,
          required.length ? `## Required output files (authoritative; override any other file names above)\nWrite exactly these files with the write tool, relative to the working directory:\n${required.map((f) => `- ${f}`).join("\n")}\nThe task is not done until each exists on disk.` : "",
          t.agent === "relay-architect" ? `## plan.json must validate against this JSON Schema exactly (no extra properties; slice ids kebab-case; contracts are objects {name,pinned,location}; slice.contracts are strings; slices need dependsOn; top-level needs contracts, slices, order (array of arrays of slice ids), independence)\n\`\`\`json\n${JSON.stringify(schema("plan"))}\n\`\`\`` : "",
          `Feature dir: ${featureDir()}${t.slice ? `\nSlice: ${t.slice}` : ""}`,
        ].filter(Boolean).join("\n\n");
        if (t.step) withState(cwd, (st: any) => S.beginStep(st, t.step, { agent: t.agent, inputs: b.inputs }));
        if (t.slice) withState(cwd, (st: any) => { st.slices[t.slice] = { ...(st.slices[t.slice] || {}), status: "running" }; });
        const planProblems = () => {
          if (t.agent !== "relay-architect") return [] as string[];
          try {
            const pl = JSON.parse(fs.readFileSync(path.join(cwd, featureDir(), "plan.json"), "utf8"));
            const e = validate(schema("plan"), pl);
            return e.length ? e : checkPlan(pl);
          } catch (e: any) { return [`plan.json unreadable: ${e.message}`]; }
        };
        const problems = () => [
          ...required.filter((f) => !fs.existsSync(path.join(cwd, f))).map((f) => `missing output ${f}`),
          ...(required.every((f) => fs.existsSync(path.join(cwd, f))) ? planProblems() : []),
        ];
        let r = await runAgent({
          cwd, agent, task, signal,
          env: { RELAY_ROLE: agent.name, RELAY_FEATURE: slug!, RELAY_OWNED: JSON.stringify(ownedGlobs) },
        });
        let probs = problems();
        if (r.exitCode === 0 && probs.length) {
          // one automatic retry with concrete feedback
          r = await runAgent({
            cwd, agent, signal,
            task: `${task}\n\n## Previous attempt failed validation. Fix exactly this and write the files to disk:\n${probs.map((x) => `- ${x}`).join("\n")}`,
            env: { RELAY_ROLE: agent.name, RELAY_FEATURE: slug!, RELAY_OWNED: JSON.stringify(ownedGlobs) },
          });
          probs = problems();
        }
        const ranOk = r.exitCode === 0 && r.stopReason !== "error";
        const absent = probs;
        const ok = ranOk && absent.length === 0;
        if (t.step) {
          const outs = Array.from(new Set([...(t.outputs || []), ...required]));
          const outputs = outs.filter((f: string) => fs.existsSync(path.join(cwd, f)))
            .map((f: string) => ({ path: posix(f), sha256: S.sha256File(path.join(cwd, f)) }));
          withState(cwd, (st: any) => S.finishStep(st, t.step, { status: ok ? "done" : "failed", outputs, error: ok ? undefined : (absent.length ? `missing outputs: ${absent.join(", ")}` : r.errorMessage || r.stderr.slice(-500)) }));
        }
        prev[i] = r.output;
        const missNote = absent.length ? `\nMISSING REQUIRED OUTPUTS: ${absent.join(", ")}. Re-run this worker; do not proceed.` : "";
        return `### ${t.agent}${t.slice ? ` (${t.slice})` : ""} exit=${r.exitCode}${ok ? "" : " FAILED"}\n${r.output || r.stderr.slice(-800)}${missNote}`;
      };

      let results: string[];
      if (p.mode === "chain") { results = []; for (let i = 0; i < p.tasks.length; i++) results.push(await runTask(p.tasks[i], i)); }
      else results = await mapLimit<any, string>(p.tasks, 4, runTask);

      let violations = "";
      if (needPlan) {
        const all = p.tasks.filter((t: any) => t.agent === "relay-implementor").flatMap((t: any) => plan.slices.find((s: any) => s.id === t.slice)?.files.own ?? []);
        const changed = new Set<string>();
        try {
          if (headBefore) git(cwd, "diff", "--name-only", `${headBefore}..HEAD`).split("\n").forEach((f) => f && changed.add(f));
          git(cwd, "status", "--porcelain").split("\n").forEach((l) => l && changed.add(l.slice(3).trim()));
        } catch { /* ignore */ }
        const bad = [...changed].filter((f) => !f.startsWith(".ai/") && !matchesAny(all, f));
        if (bad.length) violations = `\n\nOWNERSHIP VIOLATIONS (changed outside owned globs; bash can bypass write guards): ${bad.join(", ")}`;
      }
      return text(results.join("\n\n") + violations);
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

