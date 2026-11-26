import path from "node:path";

// Convert a simple glob (**, *, literal) to a RegExp over posix-style relative paths.
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") i++;
        re += ".*";
      } else re += "[^/]*";
    } else re += c.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(globs, rel) {
  return (globs || []).some((g) => globToRegExp(g).test(rel));
}

const ALWAYS_BLOCKED = [
  [/(^|\/)\.git(\/|$)/, "inside .git"],
  [/(^|\/)node_modules(\/|$)/, "inside node_modules"],
  [/(^|\/)\.env(\.|$)/, ".env files are protected"],
  [/^AGENTS\.md$/i, "AGENTS.md is never edited by the harness"],
  [/^README\.md$/i, "README.md is never edited by the harness"],
  [/(^|\/)\.ai\/[^/]+\/state\.json(\.tmp.*)?$/, "state.json is written only via harness_state"],
  [/(^|\/)\.ai\/\.lock$|(^|\/)\.ai\/[^/]+\/\.lock$/, "lock file is harness-managed"],
];

/** Canonical files a role must produce (repo-relative). Briefs cannot rename them. */
const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;
const NON_CODE_RE = /\.(md|txt|json|ya?ml|html|css)$/i;

/** Problems if a slice changed behavioural code without touching any test file. */
export function testGate(changedFiles) {
  const files = changedFiles.filter((f) => f && !f.startsWith(".ai/"));
  const code = files.filter((f) => !TEST_RE.test(f) && !NON_CODE_RE.test(f));
  if (!code.length || files.some((f) => TEST_RE.test(f))) return [];
  return [`slice changed code (${code.join(", ")}) but added/changed no test files; add tests for the new behaviour (a test file/dir under the slice's owned globs) and commit them`];
}

export function requiredOutputs(role, featureDir, slice, lane) {
  const f = (n) => `${featureDir}/${n}`;
  switch (role) {
    case "relay-researcher": return [f(lane ? `research-${lane}.md` : "research.md")];
    case "relay-spec-writer": return [f("spec.md"), f("features.json"), f("holdout/scenarios.json")];
    case "relay-architect": return [f("design.md"), f("design.html"), f("plan.json")];
    case "relay-repo-scout": return [f("agents-draft.md"), f("scout-report.json")];
    case "relay-implementor": return slice ? [f(`reports/impl-${slice}.md`)] : [];
    case "relay-reviewer": return [f(lane ? `reports/review-${lane}.json` : "reports/review.md")];
    case "relay-doc-reviewer": return lane ? [f(`reports/docreview-${lane}.json`)] : [];
    default: return [];
  }
}

/** Artefacts that must exist before entering a phase. */
export function phaseRequires(phase, featureDir) {
  const f = (n) => `${featureDir}/${n}`;
  const spec = [f("requirement.md"), f("spec.md"), f("features.json")];
  const design = [...spec, f("design.md"), f("plan.json")];
  const map = { "spec-approval": spec, design: [...spec, f("research.md")], "design-review": design, "design-approval": design, implement: design, verify: design, review: design };
  return map[phase] ?? [];
}

const esc = (s) => s.replace(/[.+^${}()|[\]\\?*]/g, "\\$&");

/** Files the verifier may create (regexes over repo-relative paths). */
const VERIFIER_LAYOUT = (fd) => [
  new RegExp(`^${esc(fd)}/evidence/.+`),
  new RegExp(`^${esc(fd)}/reports/verify-[^/]+\\.json$`),
  new RegExp(`^${esc(fd)}/holdout/(results\\.json|evidence/.+)$`),
  new RegExp(`^${esc(fd)}/verify-tools/verify-[^/]+\\.(mjs|js|cjs|sh|ps1|json)$`),
];

/**
 * Whether any role legitimately owns `rel` inside the feature dir. Anything else under
 * .ai/<slug>/ is a stray (scratch notes, plans, finalizers...).
 */
export function isLayoutFile(rel, featureDir) {
  rel = rel.split(path.sep).join("/");
  if (!rel.startsWith(`${featureDir}/`)) return true;
  const name = rel.slice(featureDir.length + 1);
  if (["requirement.md", "research.md", "spec.md", "features.json", "design.md", "design.html", "plan.json", "decisions.md", "state.json", "pr.md"].includes(name)) return true;
  if (["agents-draft.md", "scout-report.json", "detection.json", "init.json", "init-report.md", "baseline.json"].includes(name)) return true;
  if (name === "holdout/scenarios.json") return true;
  if (name === ".lock" || /\.tmp-/.test(name)) return true;
  if (/^reports\/(impl-[^/]+\.md|review\.md|review-[a-z0-9-]+\.json)$/.test(name)) return true;
  if (name === "concepts.md" || /^reports\/docreview-(spec|design)-[a-z0-9-]+\.(json|md)$/.test(name)) return true;
  if (/^research-[a-z0-9-]+\.md$/.test(name)) return true;
  return VERIFIER_LAYOUT(featureDir).some((re) => re.test(rel));
}

/** Read guard. README.md is blocked for the spec-writer only (spec must not be shaped by stale docs); implementors write it only when slice-owned. */
export function checkRead({ role, rel }) {
  rel = rel.split(path.sep).join("/");
  if (/(^|\/)\.ai\/[^/]+\/holdout(\/|$)/.test(rel) && !["relay-verifier", "relay-spec-writer"].includes(role)) {
    return "holdout scenarios are hidden: only the verifier (and the spec-writer who authors them) may read holdout/";
  }
  if (/(^|\/)README\.md$/i.test(rel) && role === "relay-spec-writer") {
    return "the spec-writer may not read README.md";
  }
  if (role === "relay-doc-reviewer" && /(^|\/)\.ai\/[^/]+\/(requirement\.md|concepts\.md|decisions\.md|state\.json|pr(-[^/]+)?\.md|research[^/]*\.md|reports\/.*)$/.test(rel)) {
    return "document reviewers are fresh-context: they may read only the document under review, the files it references and AGENTS.md (not the requirement, decisions, research, state or other reports)";
  }
  return null;
}

/**
 * Decide whether `role` may write `rel` (repo-relative, posix separators).
 * featureDir is e.g. ".ai/my-feature". owned = glob list for implementors.
 * Returns null when allowed, else a reason string.
 */
export function checkWrite({ role, rel, featureDir, owned = [] }) {
  rel = rel.split(path.sep).join("/").replace(/^\.\//, "");
  if (rel.startsWith("../") || path.isAbsolute(rel)) return "path is outside the repository";
  for (const [re, why] of ALWAYS_BLOCKED) {
    if (role === "relay-implementor" && re.source.includes("README")) continue; // allowed when a slice owns it
    if (re.test(rel)) return why;
  }
  const f = (name) => `${featureDir}/${name}`;
  switch (role) {
    case "relay":
      return [f("requirement.md"), f("concepts.md"), f("decisions.md"), f("pr.md"), ".ai/lessons.md"].includes(rel)
        ? null
        : "orchestrator may write only requirement.md, concepts.md, decisions.md, pr.md, lessons.md (no code)";
    case "relay-researcher":
      return rel === f("research.md") || new RegExp(`^${esc(featureDir)}/research-[a-z0-9-]+\\.md$`).test(rel) ? null : "researcher may write only research.md or research-<topic>.md";
    case "relay-repo-scout":
      return rel === f("agents-draft.md") || rel === f("scout-report.json") || new RegExp(`^${esc(featureDir)}/evidence/[^/]+$`).test(rel) ? null : "repo scout may write only agents-draft.md, scout-report.json and evidence/*";
    case "relay-spec-writer":
      return [f("spec.md"), f("features.json"), f("holdout/scenarios.json")].includes(rel) ? null : "spec-writer may write only spec.md, features.json, holdout/scenarios.json";
    case "relay-architect":
      return [f("design.md"), f("design.html"), f("plan.json")].includes(rel)
        ? null
        : "architect may write only design.md, design.html, plan.json";
    case "relay-implementor":
      if (rel.startsWith(".ai/") && !new RegExp(`^${featureDir.replace(/[.]/g, "\\.")}/reports/impl-[^/]+\\.md$`).test(rel)) {
        return "implementor may write under .ai/ only reports/impl-*.md";
      }
      if (rel.startsWith(".ai/")) return null;
      if (!matchesAny(owned, rel)) return `not in this slice's owned files (${owned.join(", ") || "none"})`;
      return null;
    case "relay-verifier":
      return VERIFIER_LAYOUT(featureDir).some((re) => re.test(rel))
        ? null
        : "verifier may write only evidence/**, reports/verify-<n>.json, verify-tools/verify-*.{mjs,js,cjs,sh,ps1,json} (no notes/plans/finalizers; never source or tests)";
    case "relay-doc-reviewer":
      return new RegExp(`^${esc(featureDir)}/reports/docreview-(spec|design)-[a-z0-9-]+\\.json$`).test(rel) && !/-(state|consolidated)\.json$/.test(rel)
        ? null : "doc reviewer may write only reports/docreview-<doc>-<lens>.json";
    case "relay-reviewer":
      return rel === f("reports/review.md") || (new RegExp(`^${esc(featureDir)}/reports/review-[a-z0-9-]+\\.json$`).test(rel) && !rel.endsWith("review-consolidated.json"))
        ? null : "reviewer may write only reports/review.md or reports/review-<lens>.json";
    default:
      return `unknown role "${role}"`;
  }
}


const WRITE_CMDS = /^(tee|cp|mv|rm|mkdir|touch|ln|install|rsync|dd|truncate|chmod|sed|out-file|set-content|add-content|new-item|copy-item|move-item|remove-item)$/i;
const SAFE_SINKS = new Set(["/dev/null", "nul", "$null", "/dev/stderr", "/dev/stdout", "&1", "&2"]);

/**
 * Best-effort confinement of bash writes: returns a reason when a redirect target or the path args of a
 * write-capable command resolve outside `cwd` (absolute, ~, or ../ escapes). Heuristic; the post-run
 * git-diff ownership revert remains the backstop inside the repo.
 */
export function bashConfinementProblem(cmd, cwd, tmpDirs = []) {
  const root = path.resolve(cwd);
  const inside = (p) => {
    const t = p.replace(/^["']|["']$/g, "");
    if (!t || SAFE_SINKS.has(t.toLowerCase())) return true;
    if (/^(~|\$HOME|\$env:|%)/i.test(t)) return false;
    const abs = path.resolve(root, t);
    const rel = path.relative(root, abs);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return true;
    return tmpDirs.some((d) => !path.relative(path.resolve(d), abs).startsWith(".."));
  };
  for (const m of cmd.matchAll(/\d*>>?\s*("[^"]+"|'[^']+'|[^\s;|&<>]+)/g)) {
    if (!inside(m[1])) return `redirect target ${m[1]} is outside the worktree`;
  }
  for (const seg of cmd.split(/&&|\|\||;|\n|\|/)) {
    const toks = seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
    if (!toks.length || !WRITE_CMDS.test(toks[0].replace(/^.*[\\/]/, ""))) continue;
    for (const t of toks.slice(1)) {
      if (t.startsWith("-") && !/[\\/]/.test(t)) continue;
      if (/[\\/.~]/.test(t) && !inside(t)) return `${toks[0]} path ${t} is outside the worktree`;
    }
  }
  return null;
}
