#!/usr/bin/env node
// Copilot preToolUse hook: reads the hook payload on stdin, prints a deny decision when a relay-* role breaks a guard.
// Command preToolUse hooks fail closed on crash/non-zero exit, so errors here deny rather than allow.
import { guardDecision } from "../lib/copilot.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
try {
  const d = guardDecision(JSON.parse(raw || "{}"));
  if (d) process.stdout.write(JSON.stringify(d) + "\n");
} catch (e) {
  process.stdout.write(JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: `relay guard error: ${e.message}` }) + "\n");
}
