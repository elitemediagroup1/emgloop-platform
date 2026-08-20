// Canonical CallGrid call identity — ONE RULE, both ingress paths.
//
// WHAT IT IS
//
// The single place that decides what a CallGrid call's identity is. It reads the
// provider's own id off a record and returns null when there is not one. That is
// the entire contract.
//
// WHY IT IS A FILE OF ITS OWN
//
// The rule existed twice, in two shapes, with two different alias lists and two
// different fabricated fallbacks:
//
//   webhook  pick(data, ['id','call_id','callId','uuid','sid'])
//              ?? 'callgrid-' + Date.now()
//   REST     pickField(record, ['id','CallId','Id','call_id','callId',
//                               'Uuid','uuid','Sid','sid'])
//              || 'callgrid-api-' + Date.now() + '-' + Math.random()...
//
// Two rules for one identity is how a call arriving by webhook and the same call
// arriving by API stop being the same call. This mirrors `callgrid-occurrence.ts`
// exactly, which is already the canonical answer to the other half of the same
// question — when did it happen — and is already shared by both paths.
//
// WHY A FABRICATED IDENTITY IS WORSE THAN A REFUSAL
//
// A synthetic id is not a weaker identity. It is a DIFFERENT CALL, every time it
// is computed:
//
//   • It can never match the provider identity, so reconciliation counts the
//     record as BOTH providerOnly (the real call, absent locally) and localOnly
//     (the fabricated one, absent at the provider) — one gap reported twice, in
//     opposite directions, on a comparison that is otherwise sound.
//   • It is not idempotent. `Date.now()` differs between two evaluations of the
//     same record, and the REST variant adds `Math.random()`, so it differs even
//     within one millisecond. A poller re-reading the same window would mint a
//     new canonical call on every pass, forever.
//
// The second point is why this lands before any polling: an overlap window is
// only safe when re-reading a record is a no-op, and a fabricated id makes that
// impossible by construction.
//
// PURE. No clock, no randomness, no I/O. Same record, same answer, always — and
// there is a test that evaluates one malformed record repeatedly to prove it.

/**
 * The key spellings a CallGrid call id has been observed under, in precedence
 * order.
 *
 * THE UNION OF WHAT BOTH PATHS ALREADY ACCEPTED, and nothing invented. The REST
 * list was the more evolved of the two — it had learned the capitalised variants
 * — and the webhook list was a subset in a different order. Taking the union
 * means a webhook record carrying `CallId` now resolves to its REAL id where it
 * previously fell through to a fabricated one, which is the correction rather
 * than a side effect of it. `id` stays first in both, so no record that resolved
 * before resolves differently now.
 */
export const CALLGRID_IDENTITY_FIELDS = [
  'id',
  'CallId',
  'Id',
  'call_id',
  'callId',
  'Uuid',
  'uuid',
  'Sid',
  'sid',
] as const;

/**
 * The provider's own id for this call, or null when the record does not carry one.
 *
 * ACCEPTS A STRING OR A FINITE NUMBER, AND NOT A BOOLEAN. `pick` and `pickField`
 * both stringify booleans, and each says in its own comment why: CallGrid sends
 * `billable` / `converted` / `paid` / `noRoute` as real JSON booleans, and
 * dropping them made a derived flag undefined. That allowance was written for
 * FLAGS. Reading it as an identity would make `"true"` a call id — a value every
 * such record would share — so identity resolution declines booleans while every
 * other field reader keeps them.
 *
 * A blank or whitespace-only value is ABSENT, not empty: an id that is not there
 * and an id that is the empty string are the same fact about the record, and
 * `normalizeExternalIdentity` downstream already treats them identically.
 */
export function resolveCallGridIdentity(record: Record<string, unknown>): string | null {
  for (const key of CALLGRID_IDENTITY_FIELDS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** The one sentence both refusals use, so the two paths report the same fact. */
export const NO_IDENTITY_MESSAGE =
  'CallGrid record carries no usable call id (' +
  CALLGRID_IDENTITY_FIELDS.join(' / ') +
  ' all absent or invalid)';
