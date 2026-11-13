// Autonomy levels (relay.config.json "autonomy"): which human approvals gate a run.
//  supervised: spec, design and the final PR text must be approved by a human.
//  gated (default): spec and design must be approved.
//  autonomous: no human approvals; relay_approval auto-approves and logs it. Deterministic gates (schemas, checks, holdout, review) still apply.
export const AUTONOMY = {
  supervised: ["spec", "design", "pr"],
  gated: ["spec", "design"],
  autonomous: [],
};

export function autonomyLevel(config) {
  const l = config?.autonomy;
  return l && Object.hasOwn(AUTONOMY, l) ? l : "gated";
}

export const requiredApprovals = (config) => AUTONOMY[autonomyLevel(config)];