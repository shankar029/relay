import { globToRegExp } from "./policy.mjs";

// Two globs may overlap if one's literal prefix contains the other's (conservative).
function prefix(g) {
  const i = g.search(/[*?]/);
  return i === -1 ? g : g.slice(0, i);
}

export function globsOverlap(a, b) {
  const pa = prefix(a), pb = prefix(b);
  if (pa === a && pb === b) return a === b;
  if (pa === a) return globToRegExp(b).test(a);
  if (pb === b) return globToRegExp(a).test(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/**
 * Check plan.json claims. Returns error strings.
 * - every slice appears in exactly one wave
 * - slices in the same wave have disjoint file sets and share no non-pinned contracts
 * - dependsOn must be satisfied by an earlier wave
 * - a wave with >1 slice requires independence.parallelizable === true
 */
export function checkPlan(plan) {
  const errors = [];
  const byId = new Map(plan.slices.map((s) => [s.id, s]));
  if (byId.size !== plan.slices.length) errors.push("duplicate slice ids");
  const pinned = new Set((plan.contracts || []).filter((c) => c.pinned).map((c) => c.name));
  const waveOf = new Map();
  plan.order.forEach((wave, wi) => wave.forEach((id) => {
    if (!byId.has(id)) errors.push(`order references unknown slice ${id}`);
    if (waveOf.has(id)) errors.push(`slice ${id} appears in more than one wave`);
    waveOf.set(id, wi);
  }));
  for (const s of plan.slices) if (!waveOf.has(s.id)) errors.push(`slice ${s.id} is not in order`);
  for (const s of plan.slices) {
    if ((s.features || []).length && !(s.tests || []).length) errors.push(`slice ${s.id} lists spec items (${s.features.join(", ")}) but no tests; map them to test files in slice.tests`);
    for (const d of s.dependsOn || []) {
      if (!byId.has(d)) errors.push(`slice ${s.id} depends on unknown ${d}`);
      else if (!(waveOf.get(d) < waveOf.get(s.id))) errors.push(`slice ${s.id} depends on ${d} which is not in an earlier wave`);
    }
    for (const c of s.contracts || []) if (!pinned.has(c)) errors.push(`slice ${s.id} uses contract ${c} that is not pinned`);
  }
  plan.order.forEach((wave, wi) => {
    if (wave.length < 2) return;
    if (!plan.independence?.parallelizable) errors.push(`wave ${wi} has parallel slices but independence.parallelizable is not true`);
    for (let i = 0; i < wave.length; i++) for (let j = i + 1; j < wave.length; j++) {
      const a = byId.get(wave[i]), b = byId.get(wave[j]);
      if (!a || !b) continue;
      for (const ga of a.files.own) for (const gb of b.files.own) {
        if (globsOverlap(ga, gb)) errors.push(`wave ${wi}: slices ${a.id} and ${b.id} overlap on ${ga} / ${gb}`);
      }
    }
  });
  return errors;
}
