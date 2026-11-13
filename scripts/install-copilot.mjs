#!/usr/bin/env node
// One-command installer for GitHub Copilot (CLI and VS Code agent mode).
// Usage: node scripts/install-copilot.mjs [--target repo|home|plugin] [--dest <dir>] [--no-guard] [--dry-run]
//   repo   (default) -> <dest or cwd>/.github/{agents,skills,hooks,relay}
//   home             -> ~/.copilot/{agents,skills,hooks,relay}   (or $COPILOT_HOME)
//   plugin           -> <dest or ./dist/copilot-plugin>  (plugin.json, agents/, skills/, hooks.json); then `copilot plugin install <dir>`
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planInstall, applyInstall } from "../lib/copilot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const target = opt("--target") || "repo";
if (!["repo", "home", "plugin"].includes(target)) {
  console.error(`unknown --target ${target} (repo|home|plugin)`);
  process.exit(2);
}
const dest = path.resolve(
  opt("--dest") ?? (target === "home" ? process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot") : target === "plugin" ? path.join(root, "dist", "copilot-plugin") : process.cwd()),
);
const cfgFile = path.join(root, "relay.config.json");
const config = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : null;
const dryRun = argv.includes("--dry-run");

const items = planInstall({ root, dest, layout: target, config, guard: !argv.includes("--no-guard") });
const written = applyInstall(items, { dryRun });
for (const p of written) console.log(`${dryRun ? "would write" : "wrote"} ${p}`);
console.log(`${dryRun ? "[dry-run] " : ""}${written.length} files -> ${dest}`);
if (target === "plugin") console.log(`next: copilot plugin install "${dest}"`);
