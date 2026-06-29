// property-ingest.ts - Sprint 17 (Connect the Real World).
//
// BROWSER SDK INGEST AUTHENTICATION - deliberately SEPARATE from the
// server-to-server HMAC signing in webhook-security.ts.
//
// Why a different model: the EMG Loop browser SDK runs in untrusted client
// code, so it CANNOT hold a secret - anything it ships is public. We therefore
// do NOT pretend browser events are HMAC-signed. Instead a browser event is
// authenticated by two PUBLIC facts that together are hard to forge usefully:
//   1. a known/active PUBLIC per-property ingest key (pk_emg_<property>), and
//   2. the request Origin/Referer host matching an allowed domain for that
//      property (so a key only works from its own site).
//
// This is intentionally a lower trust tier than signed server-to-server events
// (which keep using WEBSITE_WEBHOOK_SECRET). It stops casual/cross-site abuse
// of a property key without claiming cryptographic authenticity it cannot have.
//
// No external dependency and no @emgloop/database import: the caller passes the
// known properties in, keeping this package dependency-free.

/** A property's PUBLIC ingest identity (no secrets). */
export interface PropertyIngestIdentity {
  /** Property key, e.g. 'servicesinmycity'. */
  key: string;
  /** Public ingest key shipped in the SDK snippet, e.g. 'pk_emg_servicesinmycity'. */
  ingestKey: string;
  /** Hostnames allowed to send browser events for this property (lowercased). */
  allowedDomains: string[];
}

/** Inputs extracted from a browser SDK request. */
export interface PropertyIngestInput {
  /** Public ingest key claimed by the request (header or body). */
  ingestKey: string;
  /** Property the request claims to be (data-property). Optional cross-check. */
  property?: string;
  /** Request Origin/Referer host (no scheme, no port). May be empty. */
  originHost?: string;
  /**
   * Whether allowed-domain validation is ENFORCED. In production we enforce;
   * on preview the browser Origin may be a netlify.app host, so reviewers can
   * disable enforcement to exercise the path. Key validity is ALWAYS enforced.
   */
  enforceDomain: boolean;
}

/** Result of a browser ingest authentication check. */
export interface PropertyIngestResult {
  valid: boolean;
  /** Machine-readable reason when valid === false (or advisory note). */
  reason?: string;
  /** The resolved property key when the key was recognised. */
  property?: string;
  /** Whether the Origin/Referer host matched an allowed domain (when present). */
  domainMatched?: boolean;
  /** Short, non-secret fingerprint of the accepted key, for diagnostics. */
  keyPrefix?: string;
}

/** Normalize a host: lowercase, trim, strip scheme and port. */
export function normalizeHost(raw: string): string {
  let h = String(raw || '').trim().toLowerCase();
  if (!h) return '';
  h = h.replace(/^[a-z]+:\/\//, '');
  h = h.split('/')[0] || '';
  h = h.replace(/:\d+$/, '');
  return h;
}

/** True when host equals an allowed domain or is a subdomain of one. */
export function hostMatchesDomains(host: string, domains: string[]): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  return (domains || []).some((d) => {
    const dd = String(d || '').toLowerCase().trim();
    return dd !== '' && (h === dd || h.endsWith('.' + dd));
  });
}

/**
 * Authenticate a browser SDK event by PUBLIC ingest key + allowed-domain.
 *
 * Order (fail closed):
 *  - No ingest key claimed: reject ('missing-ingest-key').
 *  - Key not known/active for any property: reject ('unknown-ingest-key').
 *  - data-property present but does not match the key's property: reject
 *    ('property-key-mismatch').
 *  - enforceDomain && an Origin/Referer host is present but not allowed:
 *    reject ('domain-not-allowed').
 *  - enforceDomain && no Origin/Referer host at all: reject ('missing-origin')
 *    so production cannot be driven from a non-browser caller using a public
 *    key. (Server-to-server senders must use the signed path instead.)
 *  - Otherwise: accept.
 */
export function verifyPropertyIngest(
  input: PropertyIngestInput,
  known: PropertyIngestIdentity[],
): PropertyIngestResult {
  const claimedKey = String(input.ingestKey || '').trim();
  if (!claimedKey) {
    return { valid: false, reason: 'missing-ingest-key' };
  }

  const match = (known || []).find(
    (k) => k.ingestKey.toLowerCase() === claimedKey.toLowerCase(),
  );
  if (!match) {
    return { valid: false, reason: 'unknown-ingest-key' };
  }

  const claimedProperty = String(input.property || '').trim().toLowerCase();
  if (claimedProperty && claimedProperty !== match.key.toLowerCase()) {
    return { valid: false, reason: 'property-key-mismatch', property: match.key };
  }

  const host = normalizeHost(input.originHost || '');
  const domainMatched = host ? hostMatchesDomains(host, match.allowedDomains) : false;

  if (input.enforceDomain) {
    if (!host) {
      return { valid: false, reason: 'missing-origin', property: match.key };
    }
    if (!domainMatched) {
      return { valid: false, reason: 'domain-not-allowed', property: match.key };
    }
  }

  return {
    valid: true,
    property: match.key,
    domainMatched,
    keyPrefix: claimedKey.slice(0, 10),
  };
}
