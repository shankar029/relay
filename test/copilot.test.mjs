import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { toCopilot } from "../scripts/gen-copilot-agents.mjs";
import { parseFrontmatter } from "../lib/frontmatter.mjs";

test("copilot generator maps tools and keeps body", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "agents", "relay-verifier.md"), "utf8");
  const out = toCopilot(src);
  assert.match(out, /^---\nname: relay-verifier\n/);
  assert.match(out, /tools: \["read", "search", "execute", "edit"\]/);
  assert.ok(!out.includes("relay_set_passes\""));
  assert.equal(parseFrontmatter(out).body.trim(), parseFrontmatter(src).body.trim());
});
