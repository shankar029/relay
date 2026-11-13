const EXTERNAL = /\b(third[- ]party|external (api|service)s?|stripe|paypal|twilio|sendgrid|mailgun|slack|github api|openai|anthropic|s3|aws|gcp|azure|firebase|webhooks?|oauth|smtp|sms)\b/i;
const SECTION = /^#{1,6}\s*(third[- ]party|external)\b[^\n]*$/im;
const TWIN = /\b(twin|mock|stub|fake|fixture|recorded|sandbox)\b/i;

/**
 * Design-gate rule: when the spec mentions third-party/external services, design.md needs a "Third-party APIs" section
 * that names a digital twin / mock / fake for each (never call live services in verification).
 */
export function thirdPartyProblems(specText, featuresText, designText) {
  const m = EXTERNAL.exec(`${specText}\n${featuresText}`);
  if (!m) return [];
  const sec = SECTION.exec(designText);
  if (!sec) return [`design.md: spec mentions an external service ("${m[0]}") but design.md has no "Third-party APIs" section naming a twin/mock for it (see skills/relay/references/digital-twins.md)`];
  const body = designText.slice(sec.index + sec[0].length).split(/\n#{1,6}\s/)[0];
  return TWIN.test(body) ? [] : [`design.md "Third-party APIs" section must name a twin/mock/fake/fixture for each external service ("${m[0]}")`];
}