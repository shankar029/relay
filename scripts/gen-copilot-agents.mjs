#!/usr/bin/env node
// Agents-only generator (kept for compatibility). For the full install use scripts/install-copilot.mjs.
// Usage: node scripts/gen-copilot-agents.mjs [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toCopilot } from "../lib/copilot.mjs";

export { toCopilot };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const out = path.resolve(i > -1 ? process.argv[i + 1] : path.join(root, ".github", "agents"));
  const config = JSON.parse(fs.readFileSync(path.join(root, "relay.config.json"), "utf8"));
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(path.join(root, "agents")).filter((f) => f.endsWith(".md"))) {
    const name = f.replace(/\.md$/, "");
    const p = path.join(out, `${name}.agent.md`);
    fs.writeFileSync(p, toCopilot(fs.readFileSync(path.join(root, "agents", f), "utf8"), { config, orchestrator: name === "relay" }));
    console.log(`wrote ${p}`);
  }
}
