#!/usr/bin/env node
// Generates .github/agents/<name>.agent.md (GitHub Copilot custom agents) from agents/*.md.
// Format verified against https://docs.github.com/en/copilot/reference/custom-agents-configuration
// (frontmatter: description required, name/tools/model optional; tool aliases execute/read/edit/search/agent).
// PARTIAL: the harness-only tools (relay_*, harness_state) have no Copilot equivalent yet and are dropped,
// and the orchestrator skill is not translated. Treat output as a starting point; end-to-end use in Copilot is untested.
// Usage: node scripts/gen-copilot-agents.mjs [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../lib/frontmatter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outIdx = process.argv.indexOf("--out");
const out = path.resolve(outIdx > -1 ? process.argv[outIdx + 1] : path.join(root, ".github", "agents"));

const ALIAS = { read: "read", grep: "search", find: "search", ls: "search", bash: "execute", edit: "edit", write: "edit" };

export function toCopilot(text) {
  const { data, body } = parseFrontmatter(text);
  const tools = [...new Set((data.tools || "").split(",").map((t) => t.trim()).map((t) => ALIAS[t]).filter(Boolean))];
  const fm = [
    "---",
    `name: ${data.name}`,
    `description: ${JSON.stringify(data.description)}`,
    `tools: [${tools.map((t) => JSON.stringify(t)).join(", ")}]`,
    "---",
    "",
  ].join("\n");
  return fm + body.replace(/^\r?\n/, "");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(path.join(root, "agents")).filter((f) => f.endsWith(".md"))) {
    const name = f.replace(/\.md$/, "");
    fs.writeFileSync(path.join(out, `${name}.agent.md`), toCopilot(fs.readFileSync(path.join(root, "agents", f), "utf8")));
    console.log(`wrote ${path.join(out, `${name}.agent.md`)}`);
  }
}
