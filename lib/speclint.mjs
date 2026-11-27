const VAGUE = /\b(fast|quick(ly)?|slow|easy|easily|user[- ]friendly|appropriate(ly)?|reasonable|reasonably|robust|efficient(ly)?|intuitive|as needed|etc\.?|and so on|should work|seamless(ly)?|scalable|where possible|if possible)\b/i;
const PLACEHOLDER = /\bTBD\b|\bTODO\b|\btodo:|\btbd:/;

/**
 * Cheap spec lint over features.json content: every scenario needs concrete steps and no vague wording.
 * Returns warning strings (advisory; the orchestrator should send spec back to the spec-writer when non-empty).
 */
export function lintSpec(features) {
  const out = [];
  for (const it of features.items || []) {
    if (!(it.scenarios || []).length) out.push(`item ${it.name}: no scenarios (not testable)`);
    for (const sc of it.scenarios || []) {
      const where = `${it.name}/${sc.name}`;
      const steps = sc.steps || [];
      if (!steps.length) out.push(`${where}: no steps`);
      const text = [sc.description, ...steps].filter(Boolean).join(" ");
      const m = VAGUE.exec(text) || PLACEHOLDER.exec(text);
      if (m) out.push(`${where}: ambiguous wording "${m[0]}"; state a concrete, observable expectation`);
      if (steps.length && !steps.some((s) => /\b(expect|should|returns?|responds?|shows?|displays?|exits?|prints?|status|contains?|equals?|is|are)\b|\d/i.test(s))) out.push(`${where}: no step states an expected observation`);
    }
  }
  return out;
}
