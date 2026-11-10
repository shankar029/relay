// Minimal draft-07 subset validator (no dependencies).
// Supports: $ref (#/definitions/..), type, enum, const, required, properties,
// additionalProperties (boolean|schema), items, pattern, minLength, minItems,
// minimum, maximum, oneOf. Returns an array of error strings (empty = valid).

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function typeMatches(t, v) {
  const actual = typeOf(v);
  if (t === "number") return actual === "number" || actual === "integer";
  return t === actual;
}

export function validate(schema, value, root = schema, path = "$") {
  const errors = [];
  if (schema.$ref) {
    const m = /^#\/definitions\/(.+)$/.exec(schema.$ref);
    const target = m && root.definitions && root.definitions[m[1]];
    if (!target) return [`${path}: unresolved $ref ${schema.$ref}`];
    return validate(target, value, root, path);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) {
      return [`${path}: expected ${types.join("|")}, got ${typeOf(value)}`];
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(", ")}`);
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s) => validate(s, value, root, path).length === 0).length;
    if (ok !== 1) errors.push(`${path}: must match exactly one of oneOf (matched ${ok})`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, root, `${path}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    for (const r of schema.required || []) if (!(r in value)) errors.push(`${path}: missing required "${r}"`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errors.push(...validate(props[k], v, root, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${k}"`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validate(schema.additionalProperties, v, root, `${path}.${k}`));
      }
    }
  }
  return errors;
}
