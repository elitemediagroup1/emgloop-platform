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

/** Which authentication method a CallGrid webhook used to authenticate. */
export type AuthMethod = 'hmac' | 'bearer' | 'static-header' | 'unsigned-preview';

/** Outcome of a full security check (signature + timestamp + replay). */
export interface WebhookSecurityResult {
  valid: boolean;
  /** Machine-readable reason when valid === false (or an advisory note). */
  reason?: string;
  /** Which authentication method succeeded (CallGrid multi-mode auth). */
  method?: AuthMethod;
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
    // Classify by MAGNITUDE, not string length. The old length<=11 heuristic
    // misread any fractional or zero-padded seconds value: "1752854400.123"
    // is 14 characters, was treated as milliseconds, and resolved to
    // 1970-01-21 — silently moving the call out of every reporting window.
    // Unix seconds are ~1.7e9 and milliseconds ~1.7e12, so 1e11 separates them
    // cleanly for any date this platform will ever see.
    return Math.abs(n) < 1e11 ? n * 1000 : n;
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

// ---- CallGrid multi-mode authentication (Sprint 17 compatibility) ----------
//
// The real CallGrid webhook UI exposes only STATIC custom headers (e.g. an
// Authorization header) and has no HMAC signing-secret feature. To stay
// compatible AND secure, the CallGrid receiver accepts three modes, tried in
// this order, all against the SAME shared secret (CALLGRID_WEBHOOK_SECRET):
//   1. HMAC  - existing signed mode, UNCHANGED (verifySignedWebhook).
//   2. bearer - Authorization: Bearer <secret>, timing-safe compared.
//   3. static-header - X-EMG-Webhook-Secret: <secret>, timing-safe compared.
// Only when NO signature header AND no token is present do we fall back to the
// unsigned-preview allowance (off-production only). Production fails closed.
//
// This helper is CallGrid-specific and does NOT change verifySignedWebhook, so
// the Website SDK path and every other provider are completely unaffected.

/** Constant-time compare of two short ASCII tokens. Never throws on length
    mismatch and never short-circuits on the first differing byte. */
export function timingSafeTokenEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(String(expected ?? ''), 'utf8');
  const b = Buffer.from(String(provided ?? ''), 'utf8');
  // Compare against a fixed-length digest so length differences do not leak via
  // an early return; timingSafeEqual itself requires equal-length buffers.
  if (a.length === 0 || b.length === 0) return false;
  const ha = createHmac('sha256', 'len').update(a).digest();
  const hb = createHmac('sha256', 'len').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Read the bearer token from an Authorization header, if present. */
function readBearer(headers: Record<string, string>): string {
  const raw = headers['authorization'] || headers['Authorization'] || '';
  const m = /^\s*Bearer\s+(.+)\s*$/i.exec(raw);
  return m && m[1] ? m[1].trim() : '';
}

/** Options for CallGrid multi-mode auth. Reuses the HMAC options verbatim. */
export interface CallGridAuthOptions extends WebhookSecurityOptions {
  /** Header names to look for a static shared-secret token (lowercased). */
  staticHeaders?: string[];
}

/**
 * Authenticate a CallGrid webhook across HMAC, bearer, and static-header modes.
 *
 * Order (fail closed):
 *  - If a signature header IS present: HMAC is authoritative. Its result
 *    (success OR failure) is returned as-is, method = 'hmac' on success. We do
 *    NOT fall through to a token after a failed signature.
 *  - Else if a bearer token is present: timing-safe compare to the secret.
 *    method = 'bearer'. Mismatch => invalid-bearer-token.
 *  - Else if a static-header token is present: timing-safe compare to the
 *    secret. method = 'static-header'. Mismatch => invalid-static-token.
 *  - Else (no signature, no token): only the unsigned-preview allowance can
 *    pass, and only when allowUnsigned is true (off-production). Otherwise
 *    reject (no-secret-configured / missing-auth).
 */
export function verifyCallGridAuth(
  headers: Record<string, string>,
  rawBody: string,
  options: CallGridAuthOptions,
): WebhookSecurityResult {
  const secret = options.secret ?? '';
  const allowUnsigned = options.allowUnsigned === true;
  const staticHeaders = options.staticHeaders ?? ['x-emg-webhook-secret'];

  // 1. HMAC - authoritative when a signature header is present. Unchanged path.
  const signaturePresent = readHeader(headers, options.signatureHeaders) !== '';
  if (signaturePresent) {
    const hmac = verifySignedWebhook(headers, rawBody, options);
    return hmac.valid ? { ...hmac, method: 'hmac' } : hmac;
  }

  // 2 + 3. Token modes require a configured secret. With no secret, only the
  //         unsigned-preview allowance can pass.
  const bearer = readBearer(headers);
  const staticToken = readHeader(headers, staticHeaders);

  if (!secret) {
    // No secret configured: a presented token cannot be validated -> reject
    // unless this is a preview that explicitly allows unsigned traffic.
    if (!bearer && !staticToken && allowUnsigned) {
      return { valid: true, reason: 'unsigned-allowed', method: 'unsigned-preview' };
    }
    return { valid: false, reason: 'no-secret-configured' };
  }

  // 2. Bearer token mode.
  if (bearer) {
    return timingSafeTokenEqual(secret, bearer)
      ? { valid: true, method: 'bearer', signaturePrefix: bearer.slice(0, 6) }
      : { valid: false, reason: 'invalid-bearer-token' };
  }

  // 3. Static-header token mode.
  if (staticToken) {
    return timingSafeTokenEqual(secret, staticToken)
      ? { valid: true, method: 'static-header', signaturePrefix: staticToken.slice(0, 6) }
      : { valid: false, reason: 'invalid-static-token' };
  }

  // No signature, no token. Allow only the preview unsigned path.
  return allowUnsigned
    ? { valid: true, reason: 'unsigned-allowed', method: 'unsigned-preview' }
    : { valid: false, reason: 'missing-auth' };
}
