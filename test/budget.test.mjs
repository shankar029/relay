import test from "node:test";
import assert from "node:assert/strict";
import { addUsage, budgetProblem, messageTokens } from "../lib/budget.mjs";

test("usage accumulates per agent and budget caps refuse further delegation", () => {
  const st = {};
  addUsage(st, "relay-implementor", { tokens: 100, turns: 3 });
  addUsage(st, "relay-implementor", { tokens: 50, turns: 1 });
  addUsage(st, "relay-verifier", { tokens: 10, turns: 1 });
  assert.deepEqual([st.usage.subagentCalls, st.usage.tokens, st.usage.byAgent["relay-implementor"].calls], [3, 160, 2]);
  assert.equal(budgetProblem(st, {}, 5), null);
  assert.match(budgetProblem(st, { maxSubagentCalls: 4 }, 2), /3\/4 subagent calls/);
  assert.equal(budgetProblem(st, { maxSubagentCalls: 4 }, 1), null);
  assert.match(budgetProblem(st, { maxTokens: 160 }), /160\/160 tokens/);
  assert.equal(budgetProblem({}, { maxTokens: 1 }), null);
});

test("messageTokens tolerates provider shapes", () => {
  assert.equal(messageTokens({ totalTokens: 9, input: 1 }), 9);
  assert.equal(messageTokens({ input: 3, output: 4 }), 7);
  assert.equal(messageTokens(undefined), 0);
});
