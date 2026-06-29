// webhook-security.ts - Sprint 17 (Connect the Real World).
//
// Shared, provider-agnostic hardening for inbound webhooks. Both the CallGrid
// and Website adapters use these helpers so every signed ingress point gets the
// same protections without duplicating crypto: 
//   1. HMAC-SHA256 signature verification (constant-time compare).
//   2. Timestamp validation - reject requests whose signed timestamp is older
//      than a tolerance window (replay window) or implausibly in the future.
//   3. Replay protection - reject a signature we have already accepted inside
//      the tolerance window (in-memory nonce cache, best-effort per instance).
//
// No vendor SDK and no external dependency: Node's built-in crypto only. The
// secret is always passed in by the caller (resolved from ProviderContext);
// nothing here reads process.env or persists anything.

import { createHmac, timingSafeEqual } from 'crypto';

/** Outcome of a full security check (signature + timestamp + replay). */
export interface WebhookSecurityResult {
  valid: boolean;
  /** Machine-readable reason when valid === false (or an advisory note). */
  reason?: string;
  /** The signed timestamp we validated, echoed back for diagnostics (ms epoch). */
  timestamp?: number;
  /** Short, non-secret fingerprint of the accepted signature, for diagnostics. */
  signaturePrefix?: string;
}

/** Tunables for a security check. All optional with safe defaults. */
export interface WebhookSecurityOptions {
  /** Shared signing secret. Empty/undefined means 'no secret configured'. */
  secret?: string;
  /** Header names to look for the signature in (lowercased), in priority order. */
  signatureHeaders: string[];
  /** Header names to look for a unix/ISO timestamp in (lowercased). */
  timestampHeaders?: string[];
  /** Max age, in seconds, a signed request may be before it is rejected. */
  toleranceSeconds?: number;
  /**
   * When true, an absent secret is treated as 'pass' (sandbox/preview only).
   * Production callers MUST pass false so the route fails closed.
   */
  allowUnsigned?: boolean;
  /**
   * When true and a secret IS configured, a missing timestamp header is
   * tolerated (signature still required). Lets providers that do not send a
   * timestamp still verify by signature alone. Defaults to true.
   */
  timestampOptional?: boolean;
}

const DEFAULT_TOLERANCE_SECONDS = 300; // 5 minutes

// ---- Replay cache (in-memory, best-effort) --------------------------------
// Maps an accepted signature to the epoch-ms it was first seen. Entries older
// than the tolerance window are pruned lazily. This is per-instance: it stops
// trivial replays within a single serverless instance's lifetime. Durable,
// cross-instance replay defence would need a shared store (see Sprint 18 notes).
const seenSignatures = new Map<string, number>();

function pruneReplayCache(now: number, toleranceMs: number): void {
  if (seenSignatures.size < 512) return;
  for (const [sig, ts] of seenSignatures) {
    if (now - ts > toleranceMs) seenSignatures.delete(sig);
  }
}

/** Read the first present header from a list of candidates (case-insensitive). */
function readHeader(headers: Record<string, string>, names: string[]): string {
  for (const n of names) {
    const v = headers[n.toLowerCase()];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** Parse a header value as an epoch-ms timestamp. Accepts unix seconds, unix
    milliseconds, or an ISO-8601 string. Returns NaN when unparseable. */
export function parseTimestamp(raw: string): number {
  if (!raw) return NaN;
  const n = Number(raw);
  if (Number.isFinite(n)) {
    // Heuristic: 10-digit values are seconds, 13-digit are milliseconds.
    return raw.trim().length <= 11 ? n * 1000 : n;
  }
  const d = Date.parse(raw);
  return Number.isFinite(d) ? d : NaN;
}

/** Constant-time hex-string compare that never throws on length mismatch. */
function safeEqualHex(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided.replace(/^sha256=/, ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Compute the canonical EMG Loop signature for a raw body.
 * When a timestamp is supplied it is bound into the signed string as
 * `<timestamp>.<body>` so the signature itself pins the timestamp (a replayed
 * body with a stale timestamp cannot be re-signed without the secret).
 */
export function computeSignature(secret: string, rawBody: string, timestamp?: number): string {
  const message = timestamp ? String(timestamp) + '.' + rawBody : rawBody;
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/**
 * Full inbound-webhook security check shared by every ingestion adapter.
 *
 * Order of checks (fail closed):
 *   - No secret configured: pass only if allowUnsigned (sandbox), else reject.
 *   - Missing signature header: reject.
 *   - Timestamp present: must parse and be within tolerance (not too old, not
 *     far in the future). Absent timestamp is tolerated only when
 *     timestampOptional !== false.
 *   - Signature: must match HMAC over either `<ts>.<body>` (if a timestamp was
 *     provided) or the raw body, using a constant-time compare.
 *   - Replay: a signature already accepted within the window is rejected.
 */
export function verifySignedWebhook(
  headers: Record<string, string>,
  rawBody: string,
  options: WebhookSecurityOptions,
): WebhookSecurityResult {
  const secret = options.secret ?? '';
  const allowUnsigned = options.allowUnsigned === true;
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const toleranceMs = toleranceSeconds * 1000;
  const timestampOptional = options.timestampOptional !== false;

  if (!secret) {
    return allowUnsigned
      ? { valid: true, reason: 'unsigned-allowed' }
      : { valid: false, reason: 'no-secret-configured' };
  }

  const provided = readHeader(headers, options.signatureHeaders);
  if (!provided) {
    return { valid: false, reason: 'missing-signature-header' };
  }

  const now = Date.now();
  let timestamp: number | undefined;
  const tsRaw = readHeader(headers, options.timestampHeaders ?? []);
  if (tsRaw) {
    const ts = parseTimestamp(tsRaw);
    if (Number.isNaN(ts)) {
      return { valid: false, reason: 'invalid-timestamp' };
    }
    if (now - ts > toleranceMs) {
      return { valid: false, reason: 'expired-timestamp', timestamp: ts };
    }
    if (ts - now > toleranceMs) {
      return { valid: false, reason: 'future-timestamp', timestamp: ts };
    }
    timestamp = ts;
  } else if (!timestampOptional) {
    return { valid: false, reason: 'missing-timestamp-header' };
  }

  // Accept a signature computed either with the bound timestamp OR over the raw
  // body alone, so providers that sign only the body still verify.
  const matches =
    (timestamp !== undefined && safeEqualHex(computeSignature(secret, rawBody, timestamp), provided)) ||
    safeEqualHex(computeSignature(secret, rawBody), provided);
  if (!matches) {
    return { valid: false, reason: 'signature-mismatch' };
  }

  // Replay defence: reject a signature already accepted within the window.
  const sigKey = provided.replace(/^sha256=/, '');
  pruneReplayCache(now, toleranceMs);
  const firstSeen = seenSignatures.get(sigKey);
  if (firstSeen !== undefined && now - firstSeen <= toleranceMs) {
    return { valid: false, reason: 'replayed-signature', timestamp };
  }
  seenSignatures.set(sigKey, now);

  return {
    valid: true,
    timestamp,
    signaturePrefix: sigKey.slice(0, 12),
  };
}
