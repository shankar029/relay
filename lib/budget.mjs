// Per-run usage accounting and budget caps (relay.config.json "budget": {maxSubagentCalls, maxTokens}).

export function addUsage(state, agent, { tokens = 0, turns = 0 } = {}) {
  const u = (state.usage ||= { subagentCalls: 0, tokens: 0, turns: 0, byAgent: {} });
  u.subagentCalls += 1;
  u.tokens += tokens;
  u.turns += turns;
  const a = (u.byAgent[agent] ||= { calls: 0, tokens: 0 });
  a.calls += 1;
  a.tokens += tokens;
  return u;
}

// Returns a refusal message when delegating `n` more calls would exceed a cap, else null.
export function budgetProblem(state, budget = {}, n = 1) {
  const u = state.usage || { subagentCalls: 0, tokens: 0 };
  if (budget.maxSubagentCalls != null && u.subagentCalls + n > budget.maxSubagentCalls) {
    return `budget exceeded: ${u.subagentCalls}/${budget.maxSubagentCalls} subagent calls used. Stop delegating and report to the user (raise budget.maxSubagentCalls in relay.config.json to continue).`;
  }
  if (budget.maxTokens != null && u.tokens >= budget.maxTokens) {
    return `budget exceeded: ${u.tokens}/${budget.maxTokens} tokens used. Stop delegating and report to the user (raise budget.maxTokens in relay.config.json to continue).`;
  }
  return null;
}

// Sums pi assistant-message usage defensively (field names vary across providers).
export function messageTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  if (Number.isFinite(usage.totalTokens)) return usage.totalTokens;
  return ["input", "output", "cacheRead", "cacheWrite"].reduce((s, k) => s + (Number.isFinite(usage[k]) ? usage[k] : 0), 0);
}
