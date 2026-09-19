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
