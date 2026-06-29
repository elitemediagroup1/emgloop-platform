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
// Deploy context detection uses Netlify's CONTEXT env var (set to 'production'
// on the live site and 'deploy-preview' / 'branch-deploy' on previews) and falls
// back to NODE_ENV. Anything that is not clearly production is treated as a
// non-production preview where reviewers may exercise the pipeline unsigned.

/** True only on the live production deploy (never on previews or locally). */
export function isProductionRuntime(): boolean {
  const ctx = (process.env.CONTEXT ?? '').toLowerCase();
  if (ctx) return ctx === 'production';
  return (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
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
export function mayAllowUnsigned(connectionAllowUnsigned: boolean): boolean {
  if (isProductionRuntime()) return false;
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
  /** Whether a signing secret was configured at the time of this delivery. */
  secretConfigured: boolean;
}

/** Build the diagnostic record from a verification result. Never includes the
    secret or the full signature - only a short non-secret prefix. */
export function toVerificationDiagnostic(
  result: { valid: boolean; reason?: string; timestamp?: number; signaturePrefix?: string },
  secretConfigured: boolean,
): VerificationDiagnostic {
  return {
    at: new Date().toISOString(),
    valid: result.valid,
    reason: result.reason,
    timestamp: result.timestamp,
    signaturePrefix: result.signaturePrefix,
    secretConfigured,
  };
}
