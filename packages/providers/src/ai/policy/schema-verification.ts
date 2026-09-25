// Which providers an EXEMPT output schema has been verified against. PR 1 (AI runtime) review fix.
//
// A task schema outside the subset both providers accept carries a named exemption
// (AI_PORTABLE_SCHEMA_EXEMPTIONS in @emgloop/shared). An exemption means the other provider may reject
// that schema with a 400 -- and an availability fallback that 400s is no fallback, while INVALID_REQUEST
// never falls back. So for every exempt schema this policy names the providers it HAS been verified
// against, and deployables refuse a configuration that would make any other provider eligible: the
// connections worker at startup (NotConfigured, LOOP_AI_PROVIDERS), the connections stack at synth.
//
// Provider ids are named here because this is provider policy (the fence allows ids only in
// packages/providers/src/ai/). Remove an entry together with its exemption -- for telegram-content-
// triage.v4, in triage v5 (PR 3).

export const AI_SCHEMA_VERIFIED_PROVIDERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'telegram-content-triage.v4': Object.freeze(['anthropic']),
});

/** The listed providers that may NOT serve this schema. Empty for every schema without an entry. */
export function aiSchemaUnverifiedProviders(schemaId: string, providers: readonly string[]): string[] {
  const verified = AI_SCHEMA_VERIFIED_PROVIDERS[schemaId];
  if (!verified) return [];
  return providers.filter((p) => !verified.includes(p));
}
