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
  /** Control server port. */
  readonly port: number;
}

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
    port: Math.max(1, Number(process.env.PORT ?? '8080') || 8080),
  };
}
