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

/**
 * The exact scopes each capability requests. Nothing broader, ever.
 *
 * GMAIL CARRIES TWO, AND WHY IT CHANGED (GM-1). Until 2026-09-18 it was `gmail.metadata`
 * alone, which cannot return a message body -- verified against Google's scope reference:
 * metadata is "labels and headers, but not the email body". Loop's product is an employee
 * reading and answering business correspondence inside Loop, so it needs:
 *
 *   gmail.readonly  RESTRICTED. Reads threads, messages and labels INCLUDING bodies. It is
 *                   the narrowest scope that returns a body: the alternatives (`gmail.modify`,
 *                   `mail.google.com/`) also grant writing and deleting, which Loop must not
 *                   hold. It replaces `gmail.metadata` rather than joining it -- readonly is a
 *                   superset, and asking for both would be asking twice for less.
 *   gmail.send      SENSITIVE, not restricted. Sends a message AS the connected person and can
 *                   do nothing else: it cannot read, label, delete or draft. `gmail.compose`
 *                   would also cover drafts and is RESTRICTED, so Loop keeps its drafts in its
 *                   own store and asks only for the narrower send.
 *
 * DELIBERATELY ABSENT: `gmail.modify` and `gmail.labels`. Loop keeps its own work state, so it
 * never needs to write a label, mark a message read or delete anything in somebody's mailbox.
 */
export const GOOGLE_WORKSPACE_CAPABILITY_SCOPES: Readonly<Record<GoogleWorkspaceCapability, readonly string[]>> = Object.freeze({
  gmail: Object.freeze(['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']),
  calendar: Object.freeze(['https://www.googleapis.com/auth/calendar.events.readonly']),
  drive: Object.freeze(['https://www.googleapis.com/auth/drive.metadata.readonly']),
});

/**
 * Scopes Loop granted in an earlier version and still recognises on a stored connection.
 *
 * A connection linked before GM-1 holds `gmail.metadata`. It is not an error and it is not a
 * wider grant -- it is a NARROWER one, and it no longer covers the Gmail capability, so that
 * connection reports INSUFFICIENT_SCOPE until the person reconnects. Keeping it recognised is
 * what makes that an honest reconnect prompt rather than a refused grant.
 */
export const GOOGLE_WORKSPACE_LEGACY_SCOPES: readonly string[] = Object.freeze([
  'https://www.googleapis.com/auth/gmail.metadata',
]);

/**
 * Which capability a legacy scope was once the whole of.
 *
 * It answers one question only: did this person ever ASK for this capability. Somebody who
 * connected Gmail in September asked for Gmail, and their connection should say "reconnect",
 * not "never connected" -- the second would be Loop forgetting something the person did.
 */
export const GOOGLE_WORKSPACE_LEGACY_CAPABILITY: Readonly<Record<string, GoogleWorkspaceCapability>> = Object.freeze({
  'https://www.googleapis.com/auth/gmail.metadata': 'gmail',
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

/**
 * Whether Loop actually USES a capability today: something reads it, stores it and shows it.
 *
 * DRIVE IS AUTHORIZED, NOT USED. The scope exists and a person may already hold a grant for it,
 * but there is no Drive sensor, no cycle source, no stored Drive fact and no Drive surface. So
 * Connections offers no "Connect Drive" (a button for something that is not built is a promise
 * Loop cannot keep), says plainly that Drive is not read, and still lets a person remove an
 * authorization they gave earlier. Flip this only together with the pipeline that reads it.
 */
export const GOOGLE_WORKSPACE_CAPABILITY_IN_USE: Readonly<Record<GoogleWorkspaceCapability, boolean>> = Object.freeze({
  gmail: true,
  calendar: true,
  drive: false,
});

/** The capabilities Loop reads today, in canonical order. */
export const GOOGLE_WORKSPACE_CAPABILITIES_IN_USE: readonly GoogleWorkspaceCapability[] = Object.freeze(
  GOOGLE_WORKSPACE_CAPABILITIES.filter((c) => GOOGLE_WORKSPACE_CAPABILITY_IN_USE[c]),
);

/** What granting a capability lets Loop read -- and what it never can. Shown before consent. */
export const GOOGLE_WORKSPACE_CAPABILITY_READS: Readonly<Record<GoogleWorkspaceCapability, string>> = Object.freeze({
  gmail: 'Your mail, so Loop can show it. Headers and labels are stored; a message body is read only when you open the conversation, and is never stored. Loop sends a reply only when you press Send, from your own account. It never sends on its own, and cannot change or delete mail.',
  calendar: 'Events on your calendars, read-only. Loop cannot create, change or delete events.',
  drive: 'Loop does not read Drive yet, so nothing from Drive appears in Loop. If you allowed it earlier, Loop holds permission to see file names, types, owners and modified times, uses none of it, and cannot open, change or delete files.',
});

const CAPABILITY_BY_SCOPE: ReadonlyMap<string, GoogleWorkspaceCapability> = new Map(
  GOOGLE_WORKSPACE_CAPABILITIES.flatMap((c) => GOOGLE_WORKSPACE_CAPABILITY_SCOPES[c].map((scope) => [scope, c] as const)),
);

/** Every scope Loop may ever hold on a connection, current or legacy. Nothing else is stored. */
export const GOOGLE_WORKSPACE_ALL_SCOPES: readonly string[] = Object.freeze([
  ...GOOGLE_WORKSPACE_CAPABILITIES.flatMap((c) => [...GOOGLE_WORKSPACE_CAPABILITY_SCOPES[c]]),
  ...GOOGLE_WORKSPACE_LEGACY_SCOPES,
]);

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
  return [...GOOGLE_IDENTITY_SCOPES, ...googleCapabilityScopes(capabilities)];
}

/** The capability scopes of a set of capabilities, in canonical order. */
export function googleCapabilityScopes(capabilities: Iterable<GoogleWorkspaceCapability>): string[] {
  return inOrder(capabilities).flatMap((c) => [...GOOGLE_WORKSPACE_CAPABILITY_SCOPES[c]]);
}

/**
 * The capabilities a set of stored scopes COVERS, in canonical order.
 *
 * A capability is covered only when EVERY scope it needs is present. A Gmail connection
 * holding the read scope and not the send scope is a partly granted Gmail, and reporting it
 * as Gmail would promise a reply the employee could never send.
 */
export function googleCapabilitiesOf(scopes: Iterable<string>): GoogleWorkspaceCapability[] {
  const held = new Set(scopes);
  return GOOGLE_WORKSPACE_CAPABILITIES.filter((c) => GOOGLE_WORKSPACE_CAPABILITY_SCOPES[c].every((scope) => held.has(scope)));
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
  const capabilityScopes: string[] = [];
  for (const entry of granted) {
    if (CAPABILITY_BY_SCOPE.has(entry) || GOOGLE_WORKSPACE_LEGACY_SCOPES.includes(entry)) capabilityScopes.push(entry);
    else if (!GOOGLE_IDENTITY_GRANTS.has(entry)) return { ok: false, reason: 'UNEXPECTED_SCOPE' };
  }
  // The scopes are stored as granted -- including a partial grant, which is a real thing a
  // person can choose on Google's consent screen. The capabilities are what those scopes
  // actually cover, which is a different question and never the wider answer.
  const ordered = googleCapabilitiesOf(capabilityScopes);
  const stored = GOOGLE_WORKSPACE_ALL_SCOPES.filter((s) => capabilityScopes.includes(s));
  return { ok: true, capabilities: ordered, capabilityScopes: stored };
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
    const scopes = GOOGLE_WORKSPACE_CAPABILITY_SCOPES[capability];
    // EVERY scope, not any: a half-granted capability is not granted. A connection made before
    // Gmail needed a body scope lands here as INSUFFICIENT_SCOPE, which is the honest answer --
    // it was asked for, it is not covered, and reconnecting fixes it.
    const granted = scopes.every((scope) => connection?.grantedScopes.includes(scope) ?? false);
    const asked = [
      ...scopes,
      ...GOOGLE_WORKSPACE_LEGACY_SCOPES.filter((scope) => GOOGLE_WORKSPACE_LEGACY_CAPABILITY[scope] === capability),
    ];
    const requested = asked.some((scope) => (connection?.requestedScopes.includes(scope) ?? false) || (connection?.grantedScopes.includes(scope) ?? false));
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
