// Best-effort secret detection. Heuristic: a clean scan is not proof of absence.
const PATTERNS = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/],
  ["generic-assignment", /\b(api[_-]?key|secret|password|token)\b\s*[:=]\s*["']?[A-Za-z0-9/+._-]{16,}/i],
];

export function scanText(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [name, re] of PATTERNS) if (re.test(line)) hits.push({ line: i + 1, rule: name });
  });
  return hits;
}

export function maskText(text) {
  let out = text;
  for (const [, re] of PATTERNS) out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), "[REDACTED]");
  return out;
}
