import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { modelForTier } from "../extensions/harness/run.ts";

test("modelForTier: a repo config without tiers does not hide the workspace parent's tiers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tier-"));
  const repo = path.join(root, "api"); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(root, "relay.config.json"), JSON.stringify({ workspace: { repos: ["api"] }, tiers: { strong: "p/m" } }));
  fs.writeFileSync(path.join(repo, "relay.config.json"), JSON.stringify({ checks: { test: "npm test" } }));
  assert.equal(modelForTier(repo, "strong"), "p/m");
  fs.writeFileSync(path.join(repo, "relay.config.json"), JSON.stringify({ tiers: { strong: "own/x" } }));
  assert.equal(modelForTier(repo, "strong"), "own/x");
  fs.rmSync(root, { recursive: true, force: true });
});