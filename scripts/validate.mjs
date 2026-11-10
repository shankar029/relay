#!/usr/bin/env node
// Lints skills/agents frontmatter and validates schemas against sample fixtures.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../lib/frontmatter.mjs";
import { validate } from "../lib/jsonschema.mjs";
import { newState } from "../lib/state.mjs";
import { checkPlan } from "../lib/plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const err = (m) => errors.push(m);
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const KNOWN_TOOLS = new Set([
  "read", "grep", "find", "ls", "bash", "edit", "write",
  "relay_subagent", "harness_state", "relay_approval", "relay_checks", "relay_secret_scan", "relay_set_passes",
]);

function lintFrontmatter(file, expectedName, { maxLines } = {}) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, "utf8");
  const { data } = parseFrontmatter(text);
  if (!data.name) err(`${rel}: missing name`);
  else {
    if (!NAME_RE.test(data.name) || data.name.length > 64) err(`${rel}: invalid name '${data.name}'`);
    if (data.name !== expectedName) err(`${rel}: name '${data.name}' != '${expectedName}'`);
  }
  if (!data.description) err(`${rel}: missing description`);
  else if (data.description.length > 1024) err(`${rel}: description > 1024 chars`);
  if (maxLines && text.split("\n").length >= maxLines) err(`${rel}: >= ${maxLines} lines`);
  return data;
}

for (const d of fs.readdirSync(path.join(root, "skills"), { withFileTypes: true })) {
  if (d.isDirectory()) lintFrontmatter(path.join(root, "skills", d.name, "SKILL.md"), d.name, { maxLines: 500 });
}
for (const f of fs.readdirSync(path.join(root, "agents")).filter((f) => f.endsWith(".md"))) {
  const data = lintFrontmatter(path.join(root, "agents", f), f.replace(/\.md$/, ""));
  for (const t of (data.tools || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!KNOWN_TOOLS.has(t)) err(`agents/${f}: unknown tool '${t}'`);
  }
  if (data.tier && !["cheap", "mid", "strong"].includes(data.tier)) err(`agents/${f}: bad tier '${data.tier}'`);
}

const schema = (n) => JSON.parse(fs.readFileSync(path.join(root, "schemas", `${n}.schema.json`), "utf8"));
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", n), "utf8"));
const check = (label, s, v) => validate(schema(s), v).forEach((e) => err(`${label}: ${e}`));
check("state (newState)", "state", newState({ slug: "sample-feature", requirement: "x" }));
check("features sample", "features", fixture("features.sample.json"));
check("plan sample", "plan", fixture("plan.sample.json"));
checkPlan(fixture("plan.sample.json")).forEach((e) => err(`plan sample: ${e}`));
check("verifier-report sample", "verifier-report", fixture("verifier-report.sample.json"));

if (errors.length) {
  console.error(errors.map((e) => `FAIL ${e}`).join("\n"));
  process.exit(1);
}
console.log("validate: OK");
