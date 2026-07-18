// Truth States — serialization.
//
// A Truth crosses process boundaries: repository → server component → API route
// → client, and eventually into stored Brain output. State must survive every
// hop. The failure this guards against is a serializer that drops `state` and
// leaves a bare value, which lands in a consumer as an unqualified number.
//
// A Truth is already JSON-shaped (measuredAt is an ISO string, never a Date),
// so serializing is validation rather than transformation. The value work is on
// the way back IN: `parseTruth` refuses to reconstruct anything malformed rather
// than producing a half-valid object a caller would then render.

import type { Coverage, Reason, Truth, TruthError, TruthEvidenceRef } from './state';

export type SerializedTruth = Record<string, unknown>;

/** Serialize for transport. Total, lossless, and never throws. */
export function serializeTruth<T>(truth: Truth<T>): SerializedTruth {
  return { ...truth } as SerializedTruth;
}

class TruthParseError extends Error {
  constructor(message: string) {
    super(`Malformed Truth: ${message}`);
    this.name = 'TruthParseError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseReason(v: unknown, where: string): Reason {
  if (!isRecord(v)) throw new TruthParseError(`${where} must be an object`);
  if (typeof v.code !== 'string' || !v.code) throw new TruthParseError(`${where}.code must be a non-empty string`);
  if (typeof v.summary !== 'string' || !v.summary) throw new TruthParseError(`${where}.summary must be a non-empty string`);
  const out: Reason = { code: v.code, summary: v.summary };
  if (typeof v.detail === 'string') out.detail = v.detail;
  if (typeof v.unblockedBy === 'string') out.unblockedBy = v.unblockedBy;
  if (typeof v.provider === 'string') out.provider = v.provider;
  if (typeof v.citation === 'string') out.citation = v.citation;
  return out;
}

function parseCoverage(v: unknown): Coverage {
  if (!isRecord(v)) throw new TruthParseError('coverage must be an object');
  if (typeof v.observed !== 'number' || !Number.isFinite(v.observed)) {
    throw new TruthParseError('coverage.observed must be a finite number');
  }
  // null is meaningful here: the denominator itself is unknown.
  if (!(v.total === null || (typeof v.total === 'number' && Number.isFinite(v.total)))) {
    throw new TruthParseError('coverage.total must be a finite number or null');
  }
  return { observed: v.observed, total: v.total as number | null, reason: parseReason(v.reason, 'coverage.reason') };
}

function parseError(v: unknown): TruthError {
  if (!isRecord(v)) throw new TruthParseError('error must be an object');
  if (typeof v.code !== 'string') throw new TruthParseError('error.code must be a string');
  if (typeof v.summary !== 'string') throw new TruthParseError('error.summary must be a string');
  if (typeof v.retryable !== 'boolean') throw new TruthParseError('error.retryable must be a boolean');
  const out: TruthError = {
    code: v.code as TruthError['code'],
    summary: v.summary,
    retryable: v.retryable,
  };
  if (typeof v.detail === 'string') out.detail = v.detail;
  return out;
}

function parseEvidence(v: unknown): readonly TruthEvidenceRef[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new TruthParseError('evidence must be an array');
  return v.map((e, i) => {
    if (!isRecord(e)) throw new TruthParseError(`evidence[${i}] must be an object`);
    if (typeof e.kind !== 'string') throw new TruthParseError(`evidence[${i}].kind must be a string`);
    if (typeof e.description !== 'string') throw new TruthParseError(`evidence[${i}].description must be a string`);
    const ref: TruthEvidenceRef = { kind: e.kind, description: e.description };
    if (typeof e.ref === 'string') ref.ref = e.ref;
    return ref;
  });
}

/**
 * Reconstruct a Truth from untrusted JSON.
 *
 * `parseValue` is required for value-bearing states, so a caller cannot
 * accidentally end up with an `unknown`-typed value it then coerces. Throws
 * rather than degrading: a Truth we cannot verify is more dangerous than no
 * Truth at all, because it will be rendered as though it were checked.
 */
export function parseTruth<T>(input: unknown, parseValue: (v: unknown) => T): Truth<T> {
  if (!isRecord(input)) throw new TruthParseError('payload must be an object');

  const { state, measuredAt } = input;
  if (typeof measuredAt !== 'string' || !measuredAt) {
    throw new TruthParseError('measuredAt must be a non-empty ISO string');
  }
  const meta = {
    measuredAt,
    evidence: parseEvidence(input.evidence),
    ...(typeof input.subject === 'string' ? { subject: input.subject } : {}),
  };

  switch (state) {
    case 'success':
      return { ...meta, state: 'success', value: parseValue(input.value) };
    case 'empty':
      return { ...meta, state: 'empty', value: parseValue(input.value) };
    case 'partial':
      return { ...meta, state: 'partial', value: parseValue(input.value), coverage: parseCoverage(input.coverage) };
    case 'unknown':
      return { ...meta, state: 'unknown', reason: parseReason(input.reason, 'reason') };
    case 'unavailable':
      return { ...meta, state: 'unavailable', reason: parseReason(input.reason, 'reason') };
    case 'error':
      return { ...meta, state: 'error', error: parseError(input.error) };
    default:
      throw new TruthParseError(`unrecognized state '${String(state)}'`);
  }
}

/** Parse a numeric Truth. Rejects non-finite values rather than coercing to 0. */
export const parseNumericTruth = (input: unknown): Truth<number> =>
  parseTruth<number>(input, (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new TruthParseError('value must be a finite number');
    }
    return v;
  });
