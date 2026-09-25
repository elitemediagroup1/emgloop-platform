// The structured-output subset BOTH providers accept. PR 1 (AI runtime).
//
// Loop sends one JSON schema per task, and the routing policy may send it to either provider (a
// primary, or a fallback). A schema only one of them accepts is a fallback that fails with a 400 the
// moment it is needed. So every task schema is held to the subset both accept, and bounds the subset
// cannot say are enforced after the answer, in the task's output contract:
//
//   no `const`                    (use a one-value `enum`);
//   no numeric or string bounds   (`minimum`, `maximum`, `exclusive*`, `multipleOf`, `minLength`,
//                                  `maxLength`, `pattern`, `format`);
//   no array bounds               (`minItems`, `maxItems`, `uniqueItems`);
//   every object CLOSED           (`additionalProperties: false`) and every property REQUIRED;
//   nullable is `anyOf` with `{ type: 'null' }` or a type list including 'null'.
//
// These are the rules the repository's own "both providers" test applied to Case Explanation; this
// module states them once so every task schema is checked by the same function.
//
// A NAMED EXEMPTION IS NOT A SILENT ONE. A schema that is live in production and may not change in a
// given pull request is listed in AI_PORTABLE_SCHEMA_EXEMPTIONS with the exact violation and why. The
// exemption lists what is tolerated; anything else in that schema still fails. Which providers an exempt
// schema HAS been verified against is provider policy, so it lives in @emgloop/providers
// (`AI_SCHEMA_VERIFIED_PROVIDERS`), where provider ids may be named.
//
// PURE.

const FORBIDDEN_KEYWORDS = [
  'const',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
] as const;

/** One way a schema leaves the shared subset, with the JSON path where it does. */
export interface AiPortableSchemaViolation {
  readonly path: string;
  readonly rule: 'FORBIDDEN_KEYWORD' | 'OBJECT_NOT_CLOSED' | 'PROPERTY_NOT_REQUIRED';
  readonly keyword?: string;
}

/**
 * Exemptions by output schema id. EMPTY since Chats v5 (Loop Intelligence Phase B, 2026-09-26): the one
 * exemption there ever was -- `telegram-content-triage.v4`'s `const` schemaId, live in production from
 * 2026-09-25 until triage schema v5 replaced it with a one-value `enum` -- retired with that schema, and
 * the provider guard that depended on it (AI_SCHEMA_VERIFIED_PROVIDERS) retired with it. A test holds
 * the two together: an exemption can never exist without its verified-provider list, nor the reverse.
 */
export const AI_PORTABLE_SCHEMA_EXEMPTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({});

function key(v: AiPortableSchemaViolation): string {
  return `${v.path}:${v.keyword ?? v.rule}`;
}

/** Every violation in a schema, in document order. */
export function aiPortableSchemaViolations(schema: unknown): AiPortableSchemaViolation[] {
  const out: AiPortableSchemaViolation[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    for (const keyword of FORBIDDEN_KEYWORDS) {
      if (Object.prototype.hasOwnProperty.call(n, keyword)) out.push({ path, rule: 'FORBIDDEN_KEYWORD', keyword });
    }
    const isObject = n.type === 'object' || (Array.isArray(n.type) && n.type.includes('object'));
    if (isObject) {
      if (n.additionalProperties !== false) out.push({ path, rule: 'OBJECT_NOT_CLOSED' });
      const props = n.properties && typeof n.properties === 'object' ? Object.keys(n.properties as object) : [];
      const required = Array.isArray(n.required) ? (n.required as unknown[]) : [];
      for (const p of props) if (!required.includes(p)) out.push({ path: `${path}.properties.${p}`, rule: 'PROPERTY_NOT_REQUIRED' });
    }
    for (const [k, v] of Object.entries(n)) {
      // A property NAMED like a keyword (a schema field called `format`) is a name, not a keyword.
      if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [prop, child] of Object.entries(v as Record<string, unknown>)) walk(child, `${path}.properties.${prop}`);
        continue;
      }
      walk(v, `${path}.${k}`);
    }
  };
  walk(schema, '$');
  return out;
}

/** The violations a schema has beyond its named exemptions. Empty means both providers accept it. */
export function aiUnexemptedSchemaViolations(schemaId: string, schema: unknown): AiPortableSchemaViolation[] {
  const exempt = new Set(AI_PORTABLE_SCHEMA_EXEMPTIONS[schemaId] ?? []);
  return aiPortableSchemaViolations(schema).filter((v) => !exempt.has(key(v)));
}

/** The exemption key a violation is listed under (`<path>:<keyword or rule>`). */
export function aiPortableSchemaViolationKey(v: AiPortableSchemaViolation): string {
  return key(v);
}
