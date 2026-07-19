// CallGrid call-occurrence timestamp — one canonical resolver.
//
// WHY THIS EXISTS
//
// Reconciliation reported a 16-second gap on a real record:
//
//   Loop stored     2026-07-18T23:41:46.000Z
//   Source compared 2026-07-18T23:42:02.716Z
//
// Neither was wrong about the value it read; they were reading DIFFERENT
// FIELDS. CallGrid's canonical fields for that record are:
//
//   BidId          cmrr0gv2p3g8n07jv41p11p6s
//   UTCISODate     2026-07-18T23:41:46.712Z
//   UTCUnixTime    1784418106
//   UTCUnixTimeMs  1784418106712
//
// All identify the same instant. The comparison used `createdAt` — when
// CallGrid created the RECORD, ~16s after the event — because `createdAt` was
// first in the alias list. Loop used `UTCUnixTime`, which is correct but drops
// milliseconds.
//
// PRECEDENCE (highest fidelity first)
//
//   1. UTCUnixTimeMs — epoch milliseconds, full precision
//   2. UTCISODate    — ISO-8601 with offset, full precision
//   3. UTCUnixTime   — epoch seconds, precision loss to the second
//   4. documented legacy aliases
//   5. null — REJECT. Never `new Date()`.
//
// `createdAt` and `updatedAt` are deliberately absent at every level. They are
// record-lifecycle timestamps, not call-occurrence timestamps, and substituting
// one for the other is what produced the 16-second discrepancy.
//
// LIFECYCLE MEANING IS DELIBERATELY NOT CLAIMED. We have no evidence stating
// whether this instant is call initiation, bid time, or connection. It is
// labelled "CallGrid canonical event timestamp" and nothing stronger.

/** Which raw field supplied the instant, and at what precision. */
export interface ResolvedOccurrence {
  /** The instant, or null when no usable field was present. Never "now". */
  at: Date | null;
  /** The raw field consumed, for provenance in a reconciliation report. */
  field: string | null;
  /** True when milliseconds were preserved; false when resolved to the second. */
  millisecondPrecision: boolean;
}

const NOT_RESOLVED: ResolvedOccurrence = { at: null, field: null, millisecondPrecision: false };

const finite = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
};

const asDate = (ms: number): Date | null => {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Resolve the call-occurrence instant from a raw CallGrid payload.
 *
 * Returns `at: null` rather than guessing. A record whose time we cannot
 * establish must be quarantined, not silently stamped with the ingestion time —
 * that would drop it into whatever reporting window happened to be open.
 */
export function resolveCallOccurrence(payload: Record<string, unknown>): ResolvedOccurrence {
  // 1. Epoch milliseconds — highest fidelity.
  for (const key of ['UTCUnixTimeMs', 'utcUnixTimeMs', 'occurredAtUnixMs']) {
    const n = finite(payload[key]);
    if (n !== null) {
      const at = asDate(n);
      if (at) return { at, field: key, millisecondPrecision: true };
    }
  }

  // 2. ISO-8601 with offset — full precision, unambiguous.
  for (const key of ['UTCISODate', 'utcIsoDate', 'occurredAtIso']) {
    const raw = payload[key];
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Date.parse(raw.trim());
      if (Number.isFinite(parsed)) {
        const at = asDate(parsed);
        // Only claim millisecond precision when the string actually carries it.
        if (at) return { at, field: key, millisecondPrecision: /\.\d{1,3}/.test(raw) };
      }
    }
  }

  // 3. Epoch seconds — correct instant, precision lost to the second.
  for (const key of ['UTCUnixTime', 'occurredAtUnix', 'utcUnixTime']) {
    const n = finite(payload[key]);
    if (n !== null) {
      // Classify by magnitude, not string length: seconds ~1.7e9, ms ~1.7e12.
      const ms = Math.abs(n) < 1e11 ? n * 1000 : n;
      const at = asDate(ms);
      if (at) return { at, field: key, millisecondPrecision: Math.abs(n) >= 1e11 };
    }
  }

  // 4. Documented legacy aliases. NOTE: createdAt / updatedAt are NOT here and
  //    must never be added — they describe the record, not the call.
  for (const key of ['occurred_at', 'started_at', 'StartTime', 'CallDateTime']) {
    const raw = payload[key];
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Date.parse(raw.trim());
      if (Number.isFinite(parsed)) {
        const at = asDate(parsed);
        if (at) return { at, field: key, millisecondPrecision: /\.\d{1,3}/.test(raw) };
      }
    }
  }

  // 5. Reject. The caller decides whether to quarantine or fail.
  return NOT_RESOLVED;
}

/** Fields that describe the RECORD, never the call. Kept explicit so the ban is greppable. */
export const NON_OCCURRENCE_TIMESTAMP_FIELDS = ['createdAt', 'updatedAt', 'created_at', 'updated_at'] as const;
