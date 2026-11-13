import fs from "node:fs";
import path from "node:path";

const STOP = new Set("the a an and or of to in on for with is are was were be it its this that when then from by as at not no returns return response status".split(" "));
const words = (s) => [...new Set(String(s).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [])].filter((w) => !STOP.has(w));

export const lessonsFile = (cwd) => path.join(cwd, ".ai", "spec-lessons.json");

export function loadLessons(cwd) {
  try { return JSON.parse(fs.readFileSync(lessonsFile(cwd), "utf8")).lessons || []; } catch { return []; }
}

/** Distil failing holdout symptoms into lessons ({symptom, keywords}); symptoms carry no scenario text by contract. */
export function recordLessons(cwd, results) {
  const lessons = loadLessons(cwd);
  let changed = false;
  for (const r of results?.results || []) {
    if (r.result !== "fail" || !r.symptom) continue;
    if (lessons.some((l) => l.symptom === r.symptom)) continue;
    const keywords = words(r.symptom);
    if (keywords.length >= 2) { lessons.push({ symptom: r.symptom, keywords }); changed = true; }
  }
  if (changed) {
    fs.mkdirSync(path.dirname(lessonsFile(cwd)), { recursive: true });
    fs.writeFileSync(lessonsFile(cwd), JSON.stringify({ lessons }, null, 2) + "\n");
  }
  return changed;
}

/** Warn when a scenario's wording overlaps (>=2 keywords) with a symptom that previously failed verification. */
export function lessonWarnings(features, lessons) {
  const out = [];
  for (const it of features.items || []) {
    for (const sc of it.scenarios || []) {
      const have = new Set(words([it.name, sc.name, sc.description, ...(sc.steps || [])].filter(Boolean).join(" ")));
      for (const l of lessons) {
        const hit = (l.keywords || []).filter((k) => have.has(k));
        if (hit.length >= 2) out.push(`${it.name}/${sc.name}: resembles a past verifier failure ("${l.symptom}"); state the exact expected behaviour and edge case explicitly`);
      }
    }
  }
  return out;
}