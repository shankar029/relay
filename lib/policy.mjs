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

export function requiredOutputs(role, featureDir, slice) {
  const f = (n) => `${featureDir}/${n}`;
  switch (role) {
    case "relay-researcher": return [f("research.md")];
    case "relay-spec-writer": return [f("spec.md"), f("features.json")];
    case "relay-architect": return [f("design.md"), f("design.html"), f("plan.json")];
    case "relay-implementor": return slice ? [f(`reports/impl-${slice}.md`)] : [];
    case "relay-reviewer": return [f("reports/review.md")];
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
  if (name === ".lock" || /\.tmp-/.test(name)) return true;
  if (/^reports\/(impl-[^/]+\.md|review\.md)$/.test(name)) return true;
  return VERIFIER_LAYOUT(featureDir).some((re) => re.test(rel));
}

/** Read guard. README.md is blocked for the spec-writer only (spec must not be shaped by stale docs); implementors write it only when slice-owned. */
export function checkRead({ role, rel }) {
  if (/(^|\/)README\.md$/i.test(rel) && role === "relay-spec-writer") {
    return "the spec-writer may not read README.md";
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
      return [f("requirement.md"), f("decisions.md"), f("pr.md"), ".ai/lessons.md"].includes(rel)
        ? null
        : "orchestrator may write only requirement.md, decisions.md, pr.md, lessons.md (no code)";
    case "relay-researcher":
      return rel === f("research.md") ? null : "researcher may write only research.md";
    case "relay-spec-writer":
      return [f("spec.md"), f("features.json")].includes(rel) ? null : "spec-writer may write only spec.md, features.json";
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
    case "relay-reviewer":
      return rel === f("reports/review.md") ? null : "reviewer may write only reports/review.md";
    default:
      return `unknown role "${role}"`;
  }
}

