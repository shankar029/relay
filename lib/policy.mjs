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

/**
 * Decide whether `role` may write `rel` (repo-relative, posix separators).
 * featureDir is e.g. ".ai/my-feature". owned = glob list for implementors.
 * Returns null when allowed, else a reason string.
 */
export function checkWrite({ role, rel, featureDir, owned = [] }) {
  rel = rel.split(path.sep).join("/").replace(/^\.\//, "");
  if (rel.startsWith("../") || path.isAbsolute(rel)) return "path is outside the repository";
  for (const [re, why] of ALWAYS_BLOCKED) if (re.test(rel)) return why;
  const f = (name) => `${featureDir}/${name}`;
  switch (role) {
    case "relay":
      return [f("requirement.md"), f("decisions.md"), ".ai/lessons.md"].includes(rel)
        ? null
        : "orchestrator may write only requirement.md, decisions.md, lessons.md (no code)";
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
      return [f("evidence/"), f("reports/"), f("verify-tools/")].some((p) => rel.startsWith(p))
        ? null
        : "verifier may write only evidence/, reports/, verify-tools/ (never source or tests)";
    case "relay-reviewer":
      return rel === f("reports/review.md") ? null : "reviewer may write only reports/review.md";
    default:
      return `unknown role "${role}"`;
  }
}

