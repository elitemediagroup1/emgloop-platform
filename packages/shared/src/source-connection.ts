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
export const CONNECTION_CAPABILITIES = ['AUTHENTICATED', 'BACKGROUND_OBSERVATION'] as const;
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
}

export const CONNECTION_PROVIDER_PROFILES: Readonly<Record<ConnectionProvider, ConnectionProviderProfile>> = Object.freeze({
  MICROSOFT_TEAMS: {
    provider: 'MICROSOFT_TEAMS',
    label: 'Microsoft Teams',
    observes: 'Who you exchanged messages with and when — never message text, titles or attachments.',
    credentialKinds: ['OAUTH_REFRESH_TOKEN'],
    claims: ['AUTHENTICATED', 'BACKGROUND_OBSERVATION'],
    requiresDeviceAuthorization: true,
  },
  TELEGRAM: {
    provider: 'TELEGRAM',
    label: 'Telegram',
    observes: 'Who you exchanged messages with and when — never message text, media or captions.',
    credentialKinds: ['MTPROTO_SESSION'],
    claims: ['AUTHENTICATED', 'BACKGROUND_OBSERVATION'],
    requiresDeviceAuthorization: true,
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
} as const);
export type SourceConnectionAuditAction =
  (typeof SOURCE_CONNECTION_AUDIT_ACTIONS)[keyof typeof SOURCE_CONNECTION_AUDIT_ACTIONS];
