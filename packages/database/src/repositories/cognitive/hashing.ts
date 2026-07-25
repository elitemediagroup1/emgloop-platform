// Cognitive identity — keyed hashing for sensitive identifiers.
//
// Raw sensitive identifiers (email, phone, caller-id, device id) are NEVER
// stored. IdentityEvidence.normalizedValueHash holds a KEYED hash instead, so a
// database leak does not reveal the underlying value and the value is not
// reversible without the server secret.
//
// The hash is deterministic (so resolution can look an identity up by a
// re-derived hash) but ORGANIZATION-SALTED: the same email in two tenants
// produces two different hashes. This is a hard tenant-isolation boundary — it
// makes cross-organization identity correlation impossible even at the hash
// layer, matching the platform rule that resolution never crosses orgs.
//
// Secret material is environment-backed (COGNITIVE_HASH_SECRET). In production
// the secret MUST be set; a missing secret fails closed (throws) rather than
// silently falling back to a guessable default, so we never persist weakly
// keyed evidence.

import { createHmac } from 'crypto';

const ENV_KEY = 'COGNITIVE_HASH_SECRET';

// A clearly-marked development fallback. Only ever used outside production, and
// only when no secret is configured. Never reachable in production (see below).
const DEV_FALLBACK = 'dev-only-insecure-cognitive-hash-secret';

function resolveSecret(): string {
  const secret = process.env[ENV_KEY];
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === 'production') {
    // Fail closed: refuse to key evidence with a guessable secret in prod.
    throw new Error(
      `${ENV_KEY} is required in production to hash sensitive identifiers`,
    );
  }
  return DEV_FALLBACK;
}

/**
 * Normalize a raw identifier before hashing so trivially-different spellings
 * resolve to the same identity (case, surrounding whitespace, and — for
 * phone-like values — non-digit punctuation). Deliberately conservative: it
 * does not attempt locale-aware phone parsing, only stable canonicalization.
 */
export function normalizeIdentifier(kind: string, raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const phoneLike = /phone|caller/i.test(kind);
  if (phoneLike) {
    const digits = trimmed.replace(/\D+/g, '');
    return digits.length > 0 ? digits : trimmed;
  }
  return trimmed;
}

/**
 * Produce the org-salted keyed hash stored in IdentityEvidence.normalizedValueHash.
 * `organizationId` is folded into the HMAC input so hashes never collide across
 * tenants. Returns a hex digest.
 */
export function hashIdentifier(
  organizationId: string,
  evidenceType: string,
  rawValue: string,
): string {
  const normalized = normalizeIdentifier(evidenceType, rawValue);
  return createHmac('sha256', resolveSecret())
    .update(`${organizationId}:${evidenceType}:${normalized}`)
    .digest('hex');
}
