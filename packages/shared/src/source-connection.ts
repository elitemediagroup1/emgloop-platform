// Provider-neutral connection domain for Loop's background conversation sources
// (Microsoft Teams, Telegram, and future persistent sources). This is the shared
// vocabulary the Connections UI, the adapters and the durable worker all speak, so
// no second connection framework is introduced -- it reuses the truthful source-state
// idea already established for Google/Gmail/Calendar (deriveSourceState).
//
// It is metadata/state only: no credential, no session, no message content lives here.

export const CONNECTION_PROVIDERS = ['MICROSOFT_TEAMS', 'TELEGRAM'] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

/**
 * Loop Intelligence Phase D: whose CONTENT a person may authorize Loop to read. The background
 * connections above, plus GMAIL -- whose connection is the person's Google Workspace connection, not a
 * source connection -- gated additionally by the counterparty-consent governance decision
 * (mail-content-governance.ts). Content authorizations for every provider live in one table
 * (source_content_authorizations), revoke and offboard the same way, and are re-checked at every write.
 */
export const CONTENT_AUTHORIZATION_PROVIDERS = [...CONNECTION_PROVIDERS, 'GMAIL'] as const;
export type ContentAuthorizationProvider = (typeof CONTENT_AUTHORIZATION_PROVIDERS)[number];

/**
 * Truthful connection states. Ordered from unconfigured to terminal. `READY` means the
 * capabilities Loop claims are actually operational -- never merely "authenticated".
 * `CONNECTED_LIMITED` is authenticated but a claimed background capability is not available
 * (e.g. a provider restriction), stated honestly rather than shown as Ready.
 */
export const CONNECTION_STATES = [
  'NOT_CONNECTED',
  'CONNECTING',
  'SETTING_UP',
  'READY',
  'CONNECTED_LIMITED',
  'RECONNECT_REQUIRED',
  'FAILED',
  'DISCONNECTED',
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** What sealed material a connection holds. Folded into the seal binding (never stored raw). */
export const CONNECTION_CREDENTIAL_KINDS = ['OAUTH_REFRESH_TOKEN', 'MTPROTO_SESSION'] as const;
export type ConnectionCredentialKind = (typeof CONNECTION_CREDENTIAL_KINDS)[number];

/**
 * Which internal adapter served a Microsoft Teams connection. This is an INTERNAL detail
 * chosen after the employee authenticates; the employee only ever sees one "Microsoft Teams"
 * connection. GRAPH is used for work/school accounts where supported; INTERACTIVE_SESSION is
 * the employee-authorized interactive path for personal/free accounts.
 */
export const TEAMS_ADAPTERS = ['GRAPH', 'INTERACTIVE_SESSION'] as const;
export type TeamsAdapter = (typeof TEAMS_ADAPTERS)[number];

/**
 * A capability a connection may or may not actually have operational. Kept explicit so a
 * capability that a provider restriction blocks can be left GATED while the connection is
 * still truthfully "connected", instead of the whole connection being called Ready or Failed.
 */
export const CONNECTION_CAPABILITIES = ['AUTHENTICATED', 'BACKGROUND_OBSERVATION', 'HISTORICAL_BASELINE'] as const;
export type ConnectionCapability = (typeof CONNECTION_CAPABILITIES)[number];

export const CAPABILITY_STATUSES = ['OPERATIONAL', 'GATED', 'UNAVAILABLE'] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export function isConnectionProvider(v: unknown): v is ConnectionProvider {
  return typeof v === 'string' && (CONNECTION_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Reduce capability facts to the one truthful headline state a card shows. Authentication
 * alone is never READY: READY requires the background capability Loop claims to be operational.
 */
export function deriveConnectionState(facts: {
  readonly authenticated: boolean;
  readonly backgroundObservation: CapabilityStatus;
  readonly reconnectRequired: boolean;
  readonly failed: boolean;
  readonly disconnected: boolean;
}): ConnectionState {
  if (facts.disconnected) return 'DISCONNECTED';
  if (facts.failed) return 'FAILED';
  if (!facts.authenticated) return 'NOT_CONNECTED';
  if (facts.reconnectRequired) return 'RECONNECT_REQUIRED';
  if (facts.backgroundObservation === 'OPERATIONAL') return 'READY';
  // Authenticated, but the background capability is gated or unavailable: say so honestly.
  return 'CONNECTED_LIMITED';
}

// --- What a person is asked to consent to, and what a connect attempt can return ----------------
//
// The Connections UI and the lifecycle service share this vocabulary so a tile never invents its
// own copy and the service never returns a state the UI cannot render. Nothing here is a secret,
// a message, or a display name -- it is the honest description of a source and the outcome codes
// of trying to connect it.

/** The outcome of asking to begin (or end) a connection. Codes, never a provider's own text. */
export const CONNECTION_ACTION_OUTCOMES = [
  'NOT_CONFIGURED',   // this deployment has no worker/app credentials for the provider: nothing connects
  'NOT_PERMITTED',    // the person's role does not include a source connection
  'STARTED',          // a connect attempt was opened; the person continues authentication out of band
  'ALREADY_CONNECTED',// a live connection already exists for this person + provider
  'DISCONNECTED',     // an existing connection was ended at the person's request
  'NOTHING_TO_DO',    // disconnect asked for a connection that was not there
  'INVALID',          // the request did not name a known provider
] as const;
export type ConnectionActionOutcome = (typeof CONNECTION_ACTION_OUTCOMES)[number];

export function isConnectionActionOutcome(v: unknown): v is ConnectionActionOutcome {
  return typeof v === 'string' && (CONNECTION_ACTION_OUTCOMES as readonly string[]).includes(v);
}

/**
 * The honest, employee-facing description of one source. There is ONE profile per provider and
 * the employee sees ONE tile per provider; the Teams adapter (GRAPH vs INTERACTIVE_SESSION) is an
 * internal detail chosen after authentication and never surfaced.
 *
 *  - `observes`  states plainly what Loop records (metadata only -- who and when, never content).
 *  - `credentialKinds` are the sealed material this provider may hold, so the seal binding and the
 *    worker know what to expect; the connection stores exactly one, chosen at connect time.
 *  - `claims` are the capabilities the connection asserts. BACKGROUND_OBSERVATION is a CLAIM, not a
 *    promise: it can resolve to GATED at runtime (e.g. a provider restriction), and the connection
 *    then reads CONNECTED_LIMITED rather than READY.
 *  - `requiresDeviceAuthorization` is true when authentication happens out of band (a code, a phone
 *    login, an interactive session), not as an inline browser redirect -- both current providers do.
 */
export interface ConnectionProviderProfile {
  readonly provider: ConnectionProvider;
  readonly label: string;
  readonly observes: string;
  readonly credentialKinds: readonly ConnectionCredentialKind[];
  readonly claims: readonly ConnectionCapability[];
  readonly requiresDeviceAuthorization: boolean;
  /**
   * The honest, employee-facing description of the OPTIONAL historical baseline this source can
   * import: WHO/WHEN history only (content-free), never message content. Present only where a
   * baseline is offered; absent providers do not import history.
   */
  readonly baseline?: string;
}

// WHY WE CONNECT THESE SOURCES (product principle, locked). Teams and Telegram are INTELLIGENCE
// SOURCES, not clients Loop reimplements. Loop OBSERVES an authorized source, NORMALIZES what it
// sees, and turns what matters into cross-source intelligence and governed memory -- the same model
// Gmail, Calendar, CallGrid and CRM feed, never a provider-specific silo. Loop answers "what do I
// need to know?", not "how do I recreate Teams/Telegram inside Loop?". There is deliberately no
// composer, reply, reaction, edit, delete, inbox or conversation-browsing surface: the provider
// stays the place the conversation happens, and Loop points the person back there to participate.
//
// Two more rules travel with every profile: OBSERVATION IS NOT RETENTION -- Loop may need content to
// understand what matters, but it minimizes and governs raw content and never becomes a mirror or
// archive of the provider; and PROVENANCE RETURNS TO SOURCE -- anything surfaced keeps which
// provider, which conversation, when observed and why, with a provider-native reference where
// possible so the person can open the real conversation. Privacy is unchanged: employee-private,
// no automatic private->organization promotion, D1/D2/offboarding all still apply.
export const CONNECTION_PROVIDER_PROFILES: Readonly<Record<ConnectionProvider, ConnectionProviderProfile>> = Object.freeze({
  MICROSOFT_TEAMS: {
    provider: 'MICROSOFT_TEAMS',
    label: 'Microsoft Teams',
    observes: 'Loop observes this account as an intelligence source — never a chat client. You read and reply in Teams itself; Loop surfaces what matters and points you back there.',
    credentialKinds: ['OAUTH_REFRESH_TOKEN'],
    claims: ['AUTHENTICATED', 'BACKGROUND_OBSERVATION'],
    requiresDeviceAuthorization: true,
  },
  TELEGRAM: {
    provider: 'TELEGRAM',
    label: 'Telegram',
    observes: 'Loop observes this account as an intelligence source — never a chat client. You read and reply in Telegram itself; Loop surfaces what matters and points you back there.',
    credentialKinds: ['MTPROTO_SESSION'],
    claims: ['AUTHENTICATED', 'BACKGROUND_OBSERVATION', 'HISTORICAL_BASELINE'],
    requiresDeviceAuthorization: true,
    baseline: 'Loop can read a bounded window of your past Telegram history — who a conversation was with and when, never what was said. You choose how far back (up to a year); Loop imports that metadata once, then keeps observing going forward. It is still not a chat client, and it never stores message content.',
  },
});

export function connectionProviderProfile(provider: ConnectionProvider): ConnectionProviderProfile {
  return CONNECTION_PROVIDER_PROFILES[provider];
}

/** A state a person can act on: a fresh connect is offered, or a live one can be ended. */
export function connectionIsLive(state: ConnectionState): boolean {
  return state === 'READY' || state === 'CONNECTED_LIMITED' || state === 'SETTING_UP' || state === 'CONNECTING' || state === 'RECONNECT_REQUIRED';
}

/**
 * The connection lifecycle acts worth an audit row. State churn from the worker's observation
 * cycles is NOT audited -- only the acts a person or offboarding takes, and the two moments a
 * credential is created or destroyed. Rows carry ids, the provider and a class; never a secret,
 * an account handle or a provider's own text.
 */
export const SOURCE_CONNECTION_AUDIT_ACTIONS = Object.freeze({
  started: 'source_connection.started',
  connected: 'source_connection.connected',
  disconnected: 'source_connection.disconnected',
  offboarded: 'source_connection.offboarded',
  baseline_authorized: 'source_connection.baseline.authorized',
  baseline_scope_changed: 'source_connection.baseline.scope_changed',
  baseline_revoked: 'source_connection.baseline.revoked',
  // Content-triage slice: the employee's explicit consent to process message CONTENT with AI, and
  // its withdrawal. Distinct from connecting and from the content-free history baseline.
  content_authorized: 'source_connection.content.authorized',
  content_revoked: 'source_connection.content.revoked',
  // Retention (§21.2, 2026-09-24): the worker's sweep deleted this person's derived (MODEL) items
  // for a connection that has been disconnected past the grace window. Counts only.
  derived_expired: 'source_connection.derived.expired',
} as const);
export type SourceConnectionAuditAction =
  (typeof SOURCE_CONNECTION_AUDIT_ACTIONS)[keyof typeof SOURCE_CONNECTION_AUDIT_ACTIONS];

// --- Governed historical baseline (Telegram, Slice 1) -------------------------------------------
//
// The historical baseline walks a connection's past BACKWARD from the connect point to an
// employee-chosen floor, landing the SAME content-free observations the live sweep does (who/when
// only). It is metadata/state only here: no content, no session, no cursor value that could carry a
// message. The depth is EMPLOYEE-SELECTED from a bounded allowlist -- there is deliberately NO
// all-time option -- and it advances a checkpoint that is INDEPENDENT of the live observation cursor.

/**
 * The depths an employee may pick for a historical baseline, in days. A CLOSED allowlist: any other
 * value is rejected, and there is no all-time option, by product decision. The default is 90.
 */
export const SOURCE_CONNECTION_BASELINE_WINDOWS = [30, 90, 180, 365] as const;
export type BaselineWindowDays = (typeof SOURCE_CONNECTION_BASELINE_WINDOWS)[number];

/** The default depth offered when the employee has expressed no preference. */
export const SOURCE_CONNECTION_BASELINE_DEFAULT_WINDOW_DAYS: BaselineWindowDays = 90;

/** True only for a value on the closed allowlist. Everything else -- including all-time -- is refused. */
export function isBaselineWindowDays(v: unknown): v is BaselineWindowDays {
  return typeof v === 'number' && (SOURCE_CONNECTION_BASELINE_WINDOWS as readonly number[]).includes(v);
}

/**
 * Truthful baseline states, ordered from not-begun to terminal.
 *  - NOT_STARTED  authorized with a window, but no history has been walked yet.
 *  - IN_PROGRESS  the backward walk is under way (or paused on a provider backoff).
 *  - COMPLETE     the walk reached the employee-chosen floor (or the end of history).
 *  - REVOKED      the employee stopped it; no further history is walked. Already-written
 *                 observations expire only via the existing retention policy.
 */
export const BASELINE_STATES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE', 'REVOKED'] as const;
export type BaselineState = (typeof BASELINE_STATES)[number];

export function isBaselineState(v: unknown): v is BaselineState {
  return typeof v === 'string' && (BASELINE_STATES as readonly string[]).includes(v);
}

/**
 * Reduce baseline facts to the one truthful state a checkpoint reads, mirroring deriveConnectionState:
 * priority-ordered guards, no I/O. REVOKED wins (the employee's stop is absolute); then COMPLETE once
 * the floor is reached; then IN_PROGRESS once any walk has begun; otherwise NOT_STARTED.
 */
export function deriveBaselineState(facts: {
  readonly revoked: boolean;
  readonly reachedFloor: boolean;
  readonly hasStarted: boolean;
}): BaselineState {
  if (facts.revoked) return 'REVOKED';
  if (facts.reachedFloor) return 'COMPLETE';
  if (facts.hasStarted) return 'IN_PROGRESS';
  return 'NOT_STARTED';
}

/**
 * The outcome of authorizing, re-scoping or revoking a baseline. Codes, never a provider's own text.
 */
export const SOURCE_BASELINE_ACTION_OUTCOMES = [
  'AUTHORIZED',     // a baseline was authorized (or re-authorized) at the chosen depth
  'SCOPE_CHANGED',  // the depth of an existing baseline was changed
  'REVOKED',        // an active baseline was stopped
  'NOT_IMPORTING',  // the employee chose not to import history (nothing to stop)
  'NOT_PERMITTED',  // the person's role does not include a source connection
  'NOT_CONFIGURED', // this deployment cannot connect the provider
  'NO_CONNECTION',  // there is no live connection to baseline
  'INVALID',        // the request did not name a known provider or a valid window
] as const;
export type SourceBaselineActionOutcome = (typeof SOURCE_BASELINE_ACTION_OUTCOMES)[number];

export function isSourceBaselineActionOutcome(v: unknown): v is SourceBaselineActionOutcome {
  return typeof v === 'string' && (SOURCE_BASELINE_ACTION_OUTCOMES as readonly string[]).includes(v);
}

// --- Governed content processing (Telegram content-triage slice) --------------------------------
//
// A SEPARATE consent from connecting and from the content-free history baseline. Connection alone is
// NOT this consent: this authorizes Loop to read message CONTENT transiently and have AI decide
// whether a new inbound message is meaningfully actionable. It is employee-private, revocable, and
// there is no all-provider or org-wide option -- one provider, one person, one explicit act.

/** The outcome of authorizing or revoking content processing. Codes, never a provider's own text. */
export const SOURCE_CONTENT_ACTION_OUTCOMES = [
  'AUTHORIZED',     // content processing was authorized (or re-affirmed)
  'REVOKED',        // an active content authorization was withdrawn
  'NOTHING_TO_DO',  // revoke asked for an authorization that was not there (or already revoked)
  'NOT_PERMITTED',  // the person's role does not include a source connection
  'NOT_CONFIGURED', // this deployment cannot connect the provider
  'NO_CONNECTION',  // there is no live connection to authorize content for
  'INVALID',        // the request did not name a known provider
] as const;
export type SourceContentActionOutcome = (typeof SOURCE_CONTENT_ACTION_OUTCOMES)[number];

export function isSourceContentActionOutcome(v: unknown): v is SourceContentActionOutcome {
  return typeof v === 'string' && (SOURCE_CONTENT_ACTION_OUTCOMES as readonly string[]).includes(v);
}
