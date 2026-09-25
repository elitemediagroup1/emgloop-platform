// What the connections worker reads from its deployment. Closed by default: a missing required
// value throws NotConfigured at boot, so the worker never runs half-configured.
//
// SECRETS COME FROM THE ENVIRONMENT, injected by the Fargate task from Secrets Manager (the CDK
// wires each secret's JSON key to an env var). The worker itself holds NO AWS SDK -- it reads env,
// like brain-executor. No value here is logged.

export class NotConfigured extends Error {
  constructor(what: string) {
    super(`connections worker not configured: ${what}`);
    this.name = 'NotConfigured';
  }
}

/**
 * What the worker's fatal log line may carry about a boot error. For a configuration refusal the
 * message names the SETTING (`connections worker not configured: LOOP_CONNECTION_SECRET_KEY (must
 * be 32 bytes base64)`) and never its value, so it is safe to log and is exactly what an operator
 * needs after a rolled-back first deploy. Any other error contributes its name only: an error's
 * text is where a credential or a database host could leak.
 */
export function fatalLogFields(err: unknown): { readonly name: string; readonly message?: string } {
  const name = (err as { name?: unknown } | null)?.name;
  const safeName = typeof name === 'string' && name !== '' ? name : 'error';
  if (err instanceof NotConfigured) return { name: safeName, message: err.message };
  return { name: safeName };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new NotConfigured(name);
  return v.trim();
}

function key32(name: string): Uint8Array {
  const bytes = Buffer.from(required(name), 'base64');
  if (bytes.length !== 32) throw new NotConfigured(`${name} (must be 32 bytes base64)`);
  return new Uint8Array(bytes);
}

export interface WorkerConfig {
  readonly telegram: { readonly apiId: number; readonly apiHash: string };
  /** Seals each person's MTProto session string. */
  readonly connectionSecretKey: Uint8Array;
  /** HMAC key that turns raw chat/user ids into one-way conversation keys. */
  readonly conversationSecret: string;
  /** Shared secret for the web <-> worker control channel. */
  readonly workerControlSecret: string;
  /** How often to run an observation sweep. */
  readonly sweepIntervalMs: number;
  /** Retention horizon for content-free observations. */
  readonly observationRetentionDays: number;
  /** How often to run a historical-baseline sweep (independent of the live observation sweep). */
  readonly baselineIntervalMs: number;
  /** How many message-metadata facts one baseline page fetches (bounded). */
  readonly baselinePageSize: number;
  /** Hard ceiling on how far back any baseline may walk, whatever a checkpoint says. */
  readonly baselineMaxWindowDays: number;
  /** The periodic conversation-review cadence: how often the FORWARD content-triage sweep runs (independent of the live and baseline sweeps). */
  readonly contentIntervalMs: number;
  /** How many NEW messages one forward content-triage run reads per authorization (bounded). */
  readonly contentPageSize: number;
  /** How many days back a conversation window may reach (bounded, so a window is never unbounded). */
  readonly contentWindowDays: number;
  /** How often to run the HISTORICAL content-triage backfill sweep (independent of all other sweeps). */
  readonly historicalContentIntervalMs: number;
  /** How many conversations one historical backfill sweep pages per authorization (bounded). */
  readonly historicalConversationsPerSweep: number;
  /** How often to run the Chats Intelligence HYDRATION sweep (digest-only initialization; min 60 s). */
  readonly hydrationIntervalMs: number;
  /** At most this many triage calls per authorization per hydration sweep (default 5, hard max 10). */
  readonly hydrationConversationsPerSweep: number;
  /**
   * Triage invocations LEFT for forward triage: hydration stops for the day once the organization's
   * telegram.content.triage headroom (daily cap minus used, the tightest window) is at or below this.
   */
  readonly hydrationBudgetReserve: number;
  /** Control server port. */
  readonly port: number;
}

/** The hard ceiling on hydration triage calls per authorization per sweep, whatever the environment says. */
export const HYDRATION_CONVERSATIONS_PER_SWEEP_MAX = 10;

export function readWorkerConfig(): WorkerConfig {
  const apiId = Number(required('TELEGRAM_API_ID'));
  if (!Number.isInteger(apiId) || apiId <= 0) throw new NotConfigured('TELEGRAM_API_ID (must be a positive integer)');
  return {
    telegram: { apiId, apiHash: required('TELEGRAM_API_HASH') },
    connectionSecretKey: key32('LOOP_CONNECTION_SECRET_KEY'),
    conversationSecret: required('LOOP_CONNECTION_CONVERSATION_SECRET'),
    workerControlSecret: required('LOOP_CONNECTIONS_WORKER_SECRET'),
    sweepIntervalMs: Math.max(15_000, Number(process.env.LOOP_CONNECTION_SWEEP_INTERVAL_MS ?? '60000') || 60_000),
    observationRetentionDays: Math.max(1, Number(process.env.LOOP_CONNECTION_OBSERVATION_RETENTION_DAYS ?? '30') || 30),
    baselineIntervalMs: Math.max(15_000, Number(process.env.LOOP_CONNECTION_BASELINE_INTERVAL_MS ?? '45000') || 45_000),
    baselinePageSize: Math.min(500, Math.max(1, Number(process.env.LOOP_CONNECTION_BASELINE_PAGE_SIZE ?? '200') || 200)),
    baselineMaxWindowDays: 365,
    contentIntervalMs: Math.max(15_000, Number(process.env.LOOP_CONNECTION_CONTENT_INTERVAL_MS ?? '600000') || 600_000),
    contentPageSize: Math.min(200, Math.max(1, Number(process.env.LOOP_CONNECTION_CONTENT_PAGE_SIZE ?? '50') || 50)),
    contentWindowDays: Math.min(365, Math.max(1, Number(process.env.LOOP_CONNECTION_CONTENT_WINDOW_DAYS ?? '30') || 30)),
    historicalContentIntervalMs: Math.max(15_000, Number(process.env.LOOP_CONNECTION_HISTORICAL_CONTENT_INTERVAL_MS ?? '120000') || 120_000),
    historicalConversationsPerSweep: Math.min(50, Math.max(1, Number(process.env.LOOP_CONNECTION_HISTORICAL_CONVERSATIONS_PER_SWEEP ?? '10') || 10)),
    hydrationIntervalMs: Math.max(60_000, Number(process.env.LOOP_CONNECTION_CHATS_HYDRATION_INTERVAL_MS ?? '300000') || 300_000),
    hydrationConversationsPerSweep: Math.min(
      HYDRATION_CONVERSATIONS_PER_SWEEP_MAX,
      Math.max(1, Math.floor(Number(process.env.LOOP_CONNECTION_CHATS_HYDRATION_CONVERSATIONS_PER_SWEEP ?? '5') || 5)),
    ),
    hydrationBudgetReserve: Math.min(1000, Math.max(1, Math.floor(Number(process.env.LOOP_CONNECTION_CHATS_HYDRATION_BUDGET_RESERVE ?? '20') || 20))),
    port: Math.max(1, Number(process.env.PORT ?? '8080') || 8080),
  };
}
