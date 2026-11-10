// .ai/lessons.md format, one entry per line:
//   - [2026-01-31] [relay-implementor] symptom => rule
export const LESSON_CAP = 30;
const LINE = /^- \[(\d{4}-\d{2}-\d{2})\] \[([a-z-]+)\] (.+?) => (.+)$/;

export function parseLessons(text) {
  return text.split(/\r?\n/).map((l) => LINE.exec(l)).filter(Boolean)
    .map((m) => ({ date: m[1], role: m[2], symptom: m[3], rule: m[4] }));
}

export const formatLesson = (l) => `- [${l.date}] [${l.role}] ${l.symptom} => ${l.rule}`;

export function lessonsFor(text, role) {
  return parseLessons(text).filter((l) => l.role === role || l.role === "all");
}

// Append an entry; drops the oldest when over the cap. Returns new file text.
export function addLesson(text, lesson) {
  const header = text.split(/\r?\n/).filter((l) => !LINE.test(l) && l.trim() !== "");
  const entries = parseLessons(text);
  if (entries.some((e) => e.role === lesson.role && e.rule === lesson.rule)) return text;
  entries.push(lesson);
  while (entries.length > LESSON_CAP) entries.shift();
  return [...header, "", ...entries.map(formatLesson)].join("\n") + "\n";
}
