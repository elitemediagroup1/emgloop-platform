// Canonical entity references: how intelligence names the business things it is about. Loop
// Intelligence PR 2 (the fabric), 2026-09-26.
//
// A REFERENCE, NEVER A PAYLOAD. An EntityRef is `kind:id`, a Loop-owned identifier of a canonical
// concept -- a Party, a relationship, a provider member, a market, a web page, a Work item. It carries
// no name, no address and no content; whoever reads it resolves it through the entity's own authority.
// The intelligence layer above ingestion joins on these strings and never needs to know whether one came
// from CallGrid, Gmail, Telegram or Creator Hub.
//
// THE KINDS ARE CLOSED AND EACH ID HAS A GRAMMAR. `entityRefRefusal` is the one validator; the digest
// write, the entity-link write and the domain-reading output contract all use it.
//
// PRIVACY: SOME KINDS ARE PRINCIPAL-ONLY. A conversation key, a mail thread, a calendar event and a mail
// correspondent key belong to one person's private evidence. They may appear in that person's PRINCIPAL
// intelligence and links, never in ORGANIZATION intelligence -- an org-visible reading must not be able
// to point at somebody's private conversation. Keyed ids stay keyed: a Telegram conversation is its
// one-way key, a correspondent is its address hash, never the raw provider id or address.
//
// PURE.

export const ENTITY_REF_KINDS = [
  // Loop's own records.
  'party',
  'user',
  'relationship',
  'customer',
  'creator',
  'opportunity',
  'campaign',
  'case',
  'work_instance',
  'work_item',
  // A provider-side member Loop holds a canonical copy of: provider_member:<provider>:<dimension>:<externalId>.
  'provider_member',
  // Geography and owned web presence.
  'market',
  'web_property',
  'page',
  // One person's private evidence (PRINCIPAL-only).
  'telegram_conversation',
  'work_thread',
  'work_event',
  'correspondent',
] as const;
export type EntityRefKind = (typeof ENTITY_REF_KINDS)[number];

/** Kinds that point at one person's private evidence. Never in ORGANIZATION intelligence or links. */
export const PRINCIPAL_ONLY_ENTITY_REF_KINDS: readonly EntityRefKind[] = Object.freeze(['telegram_conversation', 'work_thread', 'work_event', 'correspondent']);

/** The dimensions a provider member can be. */
export const PROVIDER_MEMBER_DIMENSIONS = ['buyer', 'vendor', 'source', 'campaign', 'destination'] as const;

export const ENTITY_REF_MAX_CHARS = 256;

const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ID_PATTERNS: Readonly<Record<EntityRefKind, RegExp>> = Object.freeze({
  party: RECORD_ID,
  user: RECORD_ID,
  relationship: RECORD_ID,
  customer: RECORD_ID,
  creator: RECORD_ID,
  opportunity: RECORD_ID,
  campaign: RECORD_ID,
  case: RECORD_ID,
  work_instance: RECORD_ID,
  work_item: RECORD_ID,
  provider_member: new RegExp(`^[a-z0-9_]{1,32}:(${PROVIDER_MEMBER_DIMENSIONS.join('|')}):[A-Za-z0-9._-]{1,128}$`),
  // country, state, optional city slug: market:us, market:us-fl, market:us-fl-tampa
  market: /^[a-z]{2}(-[a-z]{2}(-[a-z0-9]+(-[a-z0-9]+)*)?)?$/,
  web_property: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  // page:<propertyKey>:<path>, the path starting with a slash, no whitespace, query or fragment.
  page: /^[a-z0-9]+(-[a-z0-9]+)*:\/[A-Za-z0-9._~\/%-]{0,190}$/,
  // Keyed identifiers only: an HMAC key, a Loop row id, an address hash.
  telegram_conversation: /^[A-Za-z0-9_-]{16,128}$/,
  work_thread: RECORD_ID,
  work_event: RECORD_ID,
  correspondent: /^[a-f0-9]{64}$/,
});

/** A validated reference string, `kind:id`. */
export type EntityRef = string & { readonly __entityRef: unique symbol };

export const ENTITY_REF_REFUSALS = ['NOT_A_STRING', 'TOO_LONG', 'NO_KIND', 'UNKNOWN_KIND', 'BAD_ID', 'PRINCIPAL_ONLY_KIND'] as const;
export type EntityRefRefusal = (typeof ENTITY_REF_REFUSALS)[number];

/** The kind of a reference, or null when it has none this contract knows. */
export function entityRefKind(ref: string): EntityRefKind | null {
  const at = ref.indexOf(':');
  if (at <= 0) return null;
  const kind = ref.slice(0, at);
  return (ENTITY_REF_KINDS as readonly string[]).includes(kind) ? (kind as EntityRefKind) : null;
}

/**
 * Why a value is not an acceptable reference in this scope, or null when it is. ORGANIZATION scope
 * refuses the principal-only kinds.
 */
export function entityRefRefusal(value: unknown, scope: 'PRINCIPAL' | 'ORGANIZATION' = 'PRINCIPAL'): EntityRefRefusal | null {
  if (typeof value !== 'string') return 'NOT_A_STRING';
  if (value.length > ENTITY_REF_MAX_CHARS) return 'TOO_LONG';
  const at = value.indexOf(':');
  if (at <= 0) return 'NO_KIND';
  const kind = entityRefKind(value);
  if (!kind) return 'UNKNOWN_KIND';
  if (!ID_PATTERNS[kind].test(value.slice(at + 1))) return 'BAD_ID';
  if (scope === 'ORGANIZATION' && PRINCIPAL_ONLY_ENTITY_REF_KINDS.includes(kind)) return 'PRINCIPAL_ONLY_KIND';
  return null;
}

export function isEntityRef(value: unknown, scope: 'PRINCIPAL' | 'ORGANIZATION' = 'PRINCIPAL'): value is EntityRef {
  return entityRefRefusal(value, scope) === null;
}

/** Build a reference, or throw -- for producers whose inputs are already Loop ids. */
export function entityRef(kind: EntityRefKind, id: string): EntityRef {
  const ref = `${kind}:${id}`;
  const refusal = entityRefRefusal(ref);
  if (refusal) throw new Error(`not an entity reference (${refusal}): ${kind}`);
  return ref as EntityRef;
}

/** The most references one reading or one signal may carry. */
export const ENTITY_REFS_MAX_PER_DIGEST = 32;
