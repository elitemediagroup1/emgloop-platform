// Google Workspace connection: the contract. PURE -- no I/O, no environment, no clock.
//
// Architecture: docs/architecture/google-workspace-connection.md §11 (Private V1 OAuth
// contract). One Google connection per Loop user per organization, covering Gmail,
// Calendar and Drive, granted ONE CAPABILITY AT A TIME by incremental authorization.
//
// CONNECTING IS NOT SIGNING IN. Nothing here proves who a Loop user is; a person connects
// Google from inside a Loop session they already have, as a separate, declinable act.
//
// READ-ONLY, AND NO WIDER THAN THIS FILE. The three capability scopes below are the only
// Google data scopes Loop ever requests. A token response that reports anything else is
// refused whole (`parseGoogleGrantedScopes`), so a broader grant can never be stored.
// No body, no content, no send, no write -- widening any of that is a reviewed change to
// this file and to the architecture record, never a configuration value.

/** What a person can connect, in the order onboarding asks for them. */
export const GOOGLE_WORKSPACE_CAPABILITIES = ['gmail', 'calendar', 'drive'] as const;
export type GoogleWorkspaceCapability = (typeof GOOGLE_WORKSPACE_CAPABILITIES)[number];

/** The exact scope each capability requests. Nothing broader, ever. */
export const GOOGLE_WORKSPACE_CAPABILITY_SCOPES: Readonly<Record<GoogleWorkspaceCapability, string>> = Object.freeze({
  gmail: 'https://www.googleapis.com/auth/gmail.metadata',
  calendar: 'https://www.googleapis.com/auth/calendar.events.readonly',
  drive: 'https://www.googleapis.com/auth/drive.metadata.readonly',
});

/**
 * Requested with every capability: the ID token's `sub` (the stable account id) and
 * `email`. `profile` is not needed.
 */
export const GOOGLE_IDENTITY_SCOPES = Object.freeze(['openid', 'email'] as const);

/** How Google may report the identity scopes back in a token response's `scope`. */
const GOOGLE_IDENTITY_GRANTS: ReadonlySet<string> = new Set([
  'openid',
  'email',
  'https://www.googleapis.com/auth/userinfo.email',
]);

export const GOOGLE_WORKSPACE_CAPABILITY_LABELS: Readonly<Record<GoogleWorkspaceCapability, string>> = Object.freeze({
  gmail: 'Gmail',
  calendar: 'Calendar',
  drive: 'Drive',
});

/** What granting a capability lets Loop read -- and what it never can. Shown before consent. */
export const GOOGLE_WORKSPACE_CAPABILITY_READS: Readonly<Record<GoogleWorkspaceCapability, string>> = Object.freeze({
  gmail: 'Message and thread ids, labels and headers. Never message bodies or attachments, and Loop cannot send, change or delete mail.',
  calendar: 'Events on your calendars, read-only. Loop cannot create, change or delete events.',
  drive: 'File names, types, owners and modified times. Never file contents, and Loop cannot create, change or delete files.',
});

const CAPABILITY_BY_SCOPE: ReadonlyMap<string, GoogleWorkspaceCapability> = new Map(
  GOOGLE_WORKSPACE_CAPABILITIES.map((c) => [GOOGLE_WORKSPACE_CAPABILITY_SCOPES[c], c]),
);

/** Canonical order, no duplicates. */
function inOrder(capabilities: Iterable<GoogleWorkspaceCapability>): GoogleWorkspaceCapability[] {
  const wanted = new Set(capabilities);
  return GOOGLE_WORKSPACE_CAPABILITIES.filter((c) => wanted.has(c));
}

export function isGoogleWorkspaceCapability(value: unknown): value is GoogleWorkspaceCapability {
  return typeof value === 'string' && (GOOGLE_WORKSPACE_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The capabilities a request names (`gmail`, or `calendar,drive`, or a repeated
 * parameter). Null when nothing is named, when anything unknown is named, or when more
 * than the three exist -- a request is refused whole, never partly honoured.
 */
export function parseGoogleWorkspaceCapabilities(raw: unknown): GoogleWorkspaceCapability[] | null {
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => (typeof value === 'string' ? value.split(',') : [null]))
    .map((value) => (typeof value === 'string' ? value.trim() : value));
  if (parts.length === 0 || parts.length > GOOGLE_WORKSPACE_CAPABILITIES.length) return null;
  if (!parts.every(isGoogleWorkspaceCapability)) return null;
  return inOrder(parts as GoogleWorkspaceCapability[]);
}

/** The scopes an authorization request asks for: identity first, then the capabilities. */
export function googleScopesFor(capabilities: readonly GoogleWorkspaceCapability[]): string[] {
  return [...GOOGLE_IDENTITY_SCOPES, ...inOrder(capabilities).map((c) => GOOGLE_WORKSPACE_CAPABILITY_SCOPES[c])];
}

/** The capability scopes of a set of capabilities, in canonical order. */
export function googleCapabilityScopes(capabilities: Iterable<GoogleWorkspaceCapability>): string[] {
  return inOrder(capabilities).map((c) => GOOGLE_WORKSPACE_CAPABILITY_SCOPES[c]);
}

/** The capabilities a set of stored capability scopes covers, in canonical order. */
export function googleCapabilitiesOf(scopes: Iterable<string>): GoogleWorkspaceCapability[] {
  const found: GoogleWorkspaceCapability[] = [];
  for (const scope of scopes) {
    const capability = CAPABILITY_BY_SCOPE.get(scope);
    if (capability) found.push(capability);
  }
  return inOrder(found);
}

export type GoogleGrantedScopes =
  | { readonly ok: true; readonly capabilityScopes: readonly string[]; readonly capabilities: readonly GoogleWorkspaceCapability[] }
  | { readonly ok: false; readonly reason: 'MISSING' | 'UNEXPECTED_SCOPE' };

/**
 * What Google actually granted, read from a token response's space-delimited `scope`.
 *
 * Loop reads the GRANTED set, never what it asked for: a person may decline any
 * capability on Google's consent screen. Anything outside the identity scopes and the
 * three capability scopes refuses the whole grant, so a wider token is never stored.
 */
export function parseGoogleGrantedScopes(scope: unknown): GoogleGrantedScopes {
  if (typeof scope !== 'string' || scope.trim() === '') return { ok: false, reason: 'MISSING' };
  const granted = [...new Set(scope.trim().split(/\s+/))];
  const capabilities: GoogleWorkspaceCapability[] = [];
  for (const entry of granted) {
    const capability = CAPABILITY_BY_SCOPE.get(entry);
    if (capability) capabilities.push(capability);
    else if (!GOOGLE_IDENTITY_GRANTS.has(entry)) return { ok: false, reason: 'UNEXPECTED_SCOPE' };
  }
  const ordered = inOrder(capabilities);
  return { ok: true, capabilities: ordered, capabilityScopes: googleCapabilityScopes(ordered) };
}

/**
 * Where a connection stands. `REVOKED` keeps an audit trail and no credential;
 * `EXPIRED` means Google refused the stored grant, and Loop stopped calling.
 */
export const GOOGLE_CONNECTION_STATUSES = ['CONNECTED', 'EXPIRED', 'REVOKED'] as const;
export type GoogleConnectionStatus = (typeof GOOGLE_CONNECTION_STATUSES)[number];

/**
 * Where one capability stands for one person.
 *
 *   NOT_CONNECTED       never granted, or disconnected. A permanent, legitimate state.
 *   CONNECTED           granted on a live connection.
 *   INSUFFICIENT_SCOPE  asked for, and not granted (declined on Google's consent screen,
 *                       or withdrawn at Google). Recoverable by asking again.
 *   EXPIRED             granted, but Google no longer honours the connection.
 */
export type GoogleCapabilityState = 'NOT_CONNECTED' | 'CONNECTED' | 'INSUFFICIENT_SCOPE' | 'EXPIRED';

export interface GoogleConnectionScopes {
  readonly status: GoogleConnectionStatus;
  /** Capability scopes Google granted, as stored. */
  readonly grantedScopes: readonly string[];
  /** Capability scopes the person asked for on this connection. */
  readonly requestedScopes: readonly string[];
}

export function googleCapabilityStates(
  connection: GoogleConnectionScopes | null,
): Readonly<Record<GoogleWorkspaceCapability, GoogleCapabilityState>> {
  const states = {} as Record<GoogleWorkspaceCapability, GoogleCapabilityState>;
  for (const capability of GOOGLE_WORKSPACE_CAPABILITIES) {
    const scope = GOOGLE_WORKSPACE_CAPABILITY_SCOPES[capability];
    const granted = connection?.grantedScopes.includes(scope) ?? false;
    const requested = connection?.requestedScopes.includes(scope) ?? false;
    if (!connection || connection.status === 'REVOKED') states[capability] = 'NOT_CONNECTED';
    else if (connection.status === 'EXPIRED') states[capability] = granted ? 'EXPIRED' : 'NOT_CONNECTED';
    else if (granted) states[capability] = 'CONNECTED';
    else states[capability] = requested ? 'INSUFFICIENT_SCOPE' : 'NOT_CONNECTED';
  }
  return Object.freeze(states);
}

/** Where the callback returns a person: the step they started from. Stored with the state, never read from the callback. */
export const GOOGLE_CONNECT_RETURN_TARGETS = ['ONBOARDING', 'CONNECTIONS'] as const;
export type GoogleConnectReturnTarget = (typeof GOOGLE_CONNECT_RETURN_TARGETS)[number];

export function isGoogleConnectReturnTarget(value: unknown): value is GoogleConnectReturnTarget {
  return typeof value === 'string' && (GOOGLE_CONNECT_RETURN_TARGETS as readonly string[]).includes(value);
}

/**
 * Every result a connect, callback or disconnect can end in. Each is a plain reason the
 * person is shown; none carries Google's own text, a token or an address.
 */
export const GOOGLE_CONNECT_OUTCOMES = [
  'CONNECTED',
  'PARTIAL',
  'ALREADY_CONNECTED',
  'DECLINED',
  'DIFFERENT_ACCOUNT',
  'ACCOUNT_IN_USE',
  'DOMAIN_NOT_ALLOWED',
  'EMAIL_UNVERIFIED',
  'UNEXPECTED_SCOPE',
  'STATE_INVALID',
  'TOO_MANY_ATTEMPTS',
  'NOT_CONFIGURED',
  'NOT_PERMITTED',
  'INVALID_REQUEST',
  'FAILED',
  'DISCONNECTED',
  'DISCONNECTED_UNCONFIRMED',
  'NOT_CONNECTED',
] as const;
export type GoogleConnectOutcome = (typeof GOOGLE_CONNECT_OUTCOMES)[number];

export function isGoogleConnectOutcome(value: unknown): value is GoogleConnectOutcome {
  return typeof value === 'string' && (GOOGLE_CONNECT_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Why Loop gave up a connection. Recorded on the connection and in the audit trail.
 *
 *   SELF_DISCONNECT     the person disconnected Google.
 *   CAPABILITY_REMOVED  the person removed one capability; Google cannot revoke one scope
 *                       of a grant, so the whole grant is revoked and the rest re-asked.
 *   MEMBER_DISABLED     an administrator disabled the member.
 *   MEMBER_REMOVED      an administrator removed the member.
 */
export const GOOGLE_REVOCATION_REASONS = ['SELF_DISCONNECT', 'CAPABILITY_REMOVED', 'MEMBER_DISABLED', 'MEMBER_REMOVED'] as const;
export type GoogleRevocationReason = (typeof GOOGLE_REVOCATION_REASONS)[number];

/** Failure classes recorded on a connection. Never Google's text. */
export const GOOGLE_CONNECTION_FAILURE_CLASSES = [
  'REFRESH_REFUSED',
  'REVOKE_UNCONFIRMED',
  'REVOKE_SKIPPED_SHARED_GRANT',
  'TOKEN_UNOPENABLE',
] as const;
export type GoogleConnectionFailureClass = (typeof GOOGLE_CONNECTION_FAILURE_CLASSES)[number];

/** Audit actions for the connection lifecycle (architecture §9). Ids and scopes only, never content. */
export const GOOGLE_CONNECTION_AUDIT_ACTIONS = Object.freeze({
  granted: 'google.connection.granted',
  reconnected: 'google.connection.reconnected',
  scopeChanged: 'google.connection.scope_changed',
  revoked: 'google.connection.revoked',
  revokeUnconfirmed: 'google.connection.revoke_unconfirmed',
  expired: 'google.connection.expired',
} as const);
