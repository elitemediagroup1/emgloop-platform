// webhook-runtime.ts - Sprint 17 (Connect the Real World).
//
// Tiny runtime-environment helpers shared by the inbound webhook routes. The
// single most important production rule lives here: PRODUCTION MUST NEVER ACCEPT
// UNSIGNED TRAFFIC. Before Sprint 17 the routes fell back to allow-unsigned
// whenever a signing secret was absent, which is acceptable for a preview/
// sandbox deploy but unsafe for the live site. These helpers make the policy
// explicit and centralized so both the CallGrid and Website routes behave
// identically.
//
// Production detection is HOST-BASED first, because Netlify sets NODE_ENV=
// 'production' even on deploy previews, and the build-time CONTEXT var is not
// reliably present at request time. The live site is served from a fixed
// production host; everything else (deploy-preview-*.netlify.app, branch
// deploys, localhost) is a non-production preview where reviewers may exercise
// the pipeline unsigned. CONTEXT==='production' is also honoured when present.

/** The canonical production hosts for the live EMG Loop deploy. */
const PRODUCTION_HOSTS = new Set(['app.emgloop.com']);

/** True only on the live production deploy (never on previews or locally). */
export function isProductionRuntime(host?: string | null): boolean {
  // 1. Host-based (most reliable at request time).
  if (host) {
    const h = host.toLowerCase().split(':')[0] ?? '';
    if (h && PRODUCTION_HOSTS.has(h)) return true;
    // Any Netlify preview/branch subdomain is explicitly NON-production.
    if (h.endsWith('.netlify.app')) return false;
  }
  // 2. Explicit Netlify deploy context, when exposed at runtime.
  const ctx = (process.env.CONTEXT ?? '').toLowerCase();
  if (ctx) return ctx === 'production';
  // 3. With no host and no CONTEXT, be conservative ONLY if we cannot tell it is
  //    a preview. Without a host signal we fall back to NODE_ENV.
  return (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
}

/** Extract the request host from standard headers (handles proxies). */
export function hostOf(req: { headers: { get(name: string): string | null } }): string | null {
  return (
    req.headers.get('x-forwarded-host') ||
    req.headers.get('host') ||
    null
  );
}

/**
 * Whether a route may accept an UNSIGNED webhook (no secret configured).
 *
 * Production: NEVER. The route fails closed - if the signing secret is not set
 * the request is rejected, so the live Brain can never ingest forged traffic.
 *
 * Non-production (preview/branch/local): allowed, so reviewers can exercise the
 * full live pipeline against the deploy preview without a real provider secret.
 * The per-connection config.allowUnsigned flag can still force-allow in those
 * environments, but it is ignored in production.
 */
export function mayAllowUnsigned(connectionAllowUnsigned: boolean, host?: string | null): boolean {
  if (isProductionRuntime(host)) return false;
  return connectionAllowUnsigned === true;
}

/** A compact, non-secret verification record persisted on the connection so the
    Integration OS can show Last Verification / Last Signature without ever
    storing or echoing the secret or the full signature. */
export interface VerificationDiagnostic {
  at: string;
  valid: boolean;
  reason?: string;
  timestamp?: number;
  signaturePrefix?: string;
  secretConfigured: boolean;
  /** Which auth method succeeded: hmac | bearer | static-header | unsigned-preview. */
  method?: 'hmac' | 'bearer' | 'static-header' | 'unsigned-preview';
}

/** Build the diagnostic record from a verification result. Never includes the
    secret or the full signature - only a short non-secret prefix. */
export function toVerificationDiagnostic(
  result: { valid: boolean; reason?: string; timestamp?: number; signaturePrefix?: string; method?: VerificationDiagnostic['method'] },
  secretConfigured: boolean,
): VerificationDiagnostic {
  return {
    at: new Date().toISOString(),
    valid: result.valid,
    reason: result.reason,
    timestamp: result.timestamp,
    signaturePrefix: result.signaturePrefix,
    secretConfigured,
    method: result.method,
  };
}
