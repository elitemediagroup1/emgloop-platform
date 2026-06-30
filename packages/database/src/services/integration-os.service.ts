// IntegrationOsService - Sprint 16 (Integration OS) + Sprint 17 (status wiring).
//
// The read-only status engine behind the Integration Center. It derives the
// LIVE operational state of every provider from data EMG Loop already owns:
// - ProviderConnection rows (connection status, connectedAt, lastSyncedAt,
//   and the non-secret lastVerification diagnostic written by the webhooks)
// - IntegrationEvent rows (last event, events today, processed/failed,
//   retry queue, last error)
// - process.env presence (whether a required secret is configured -
//   BOOLEAN ONLY; values are never read or returned)
//
// It makes NO network calls and stores NO state. The catalog supplies the
// static spec; this service supplies the live numbers. Sprint 17 adds the
// honest live-state distinction the Integration OS shows: a provider is only
// 'live' once real events have been PROCESSED - configuring a secret alone
// makes it 'ready_for_setup', never 'live'.

import type { PrismaClient } from '@prisma/client';
import { IntegrationRepository } from '../repositories/integration.repository';

/** Overall connection posture for a provider. */
export type ConnectionState = 'connected' | 'waiting' | 'error' | 'not_configured';

/** Health rollup for a provider. */
export type HealthState = 'healthy' | 'degraded' | 'down' | 'unknown';

/**
 * Honest go-live posture, independent of health:
 * - 'live': at least one REAL event has been processed through the pipeline.
 * - 'ready_for_setup': everything in EMG Loop is configured (required secrets
 *   present) but no real event has arrived yet - the external system still
 *   needs to be pointed at us.
 * - 'needs_setup': required configuration (e.g. a signing secret) is missing.
 * - 'not_available': provider has no receiver built yet (planned).
 */
export type LiveState = 'live' | 'ready_for_setup' | 'needs_setup' | 'not_available';

/** Status of a single required secret - presence only, never the value. */
export interface SecretStatus {
  envVar: string;
  label: string;
  required: boolean;
  configured: boolean;
}

/** A single recent event row for diagnostics (no payload bodies). */
export interface EventRow {
  id: string;
  eventType: string | null;
  externalId: string | null;
  status: string;
  receivedAt: string;
  errorMessage: string | null;
}

/** The last non-secret verification diagnostic written by a webhook route. */
export interface VerificationInfo {
  at: string;
  valid: boolean;
  reason?: string;
  timestamp?: number;
  signaturePrefix?: string;
  secretConfigured: boolean;
  /** Which auth method succeeded (CallGrid multi-mode). */
  method?: 'hmac' | 'bearer' | 'static-header' | 'unsigned-preview';
}

/** The full live status snapshot for one provider. */
/** The last CallGrid REST API reconciliation sync diagnostic (no secrets). */
export interface ApiSyncInfo {
  at: string;
  range: string;
  since: string;
  until: string;
  fetched: number;
  imported: number;
  enriched: number;
  skippedDuplicate: number;
  failed: number;
  errorCount: number;
  apiKeyConfigured: boolean;
}

export interface ProviderStatus {
  providerId: string;
  connection: ConnectionState;
  connectionStatusLabel: string;
  health: HealthState;
  liveState: LiveState;
  webhookActive: boolean;
  authVerified: boolean;
  secretConfigured: boolean;
  allRequiredSecretsConfigured: boolean;
  lastEvent: EventRow | null;
  lastError: EventRow | null;
  lastVerification: VerificationInfo | null;
  apiSync: ApiSyncInfo | null;
  eventsToday: number;
  eventsProcessed: number;
  eventsFailed: number;
  retryQueueDepth: number;
  recentEvents: EventRow[];
  retryQueue: EventRow[];
  secrets: SecretStatus[];
  missingRequiredSecrets: string[];
  connectedAt: string | null;
  lastSyncedAt: string | null;
}

/** Minimal spec shape this service needs from the catalog. */
export interface ProviderStatusInput {
  providerId: string;
  hasWebhook: boolean;
  /** True when no receiver is built yet (planned providers). */
  planned?: boolean;
  secrets: { envVar: string; label: string; required: boolean }[];
}

function toRow(e: {
  id: string;
  eventType: string | null;
  externalId: string | null;
  status: string;
  receivedAt: string;
  errorMessage: string | null;
}): EventRow {
  return {
    id: e.id,
    eventType: e.eventType,
    externalId: e.externalId,
    status: e.status,
    receivedAt: e.receivedAt,
    errorMessage: e.errorMessage,
  };
}

/** Safely read the persisted lastVerification diagnostic off a connection config. */
function readVerification(config: Record<string, unknown> | undefined): VerificationInfo | null {
  const v = config?.['lastVerification'];
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o['at'] !== 'string' || typeof o['valid'] !== 'boolean') return null;
  return {
    at: o['at'] as string,
    valid: o['valid'] as boolean,
    reason: typeof o['reason'] === 'string' ? (o['reason'] as string) : undefined,
    timestamp: typeof o['timestamp'] === 'number' ? (o['timestamp'] as number) : undefined,
    signaturePrefix: typeof o['signaturePrefix'] === 'string' ? (o['signaturePrefix'] as string) : undefined,
    secretConfigured: o['secretConfigured'] === true,
    method:
      o['method'] === 'hmac' ||
      o['method'] === 'bearer' ||
      o['method'] === 'static-header' ||
      o['method'] === 'unsigned-preview'
        ? (o['method'] as VerificationInfo['method'])
        : undefined,
  };
}

/** Safely read the last API-sync diagnostic from connection.config. */
function readApiSync(config: Record<string, unknown> | undefined): ApiSyncInfo | null {
  const v = config?.['lastApiSync'];
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o['at'] !== 'string') return null;
  const num = (k: string): number => (typeof o[k] === 'number' ? (o[k] as number) : 0);
  return {
    at: o['at'] as string,
    range: typeof o['range'] === 'string' ? (o['range'] as string) : '',
    since: typeof o['since'] === 'string' ? (o['since'] as string) : '',
    until: typeof o['until'] === 'string' ? (o['until'] as string) : '',
    fetched: num('fetched'),
    imported: num('imported'),
    enriched: num('enriched'),
    skippedDuplicate: num('skippedDuplicate'),
    failed: num('failed'),
    errorCount: num('errorCount'),
    apiKeyConfigured: o['apiKeyConfigured'] === true,
  };
}

export class IntegrationOsService {
  private readonly integrations: IntegrationRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.integrations = new IntegrationRepository(prisma);
  }

  /** Read-only presence check for a server env var. Never returns the value. */
  static isSecretConfigured(envVar: string): boolean {
    const v = process.env[envVar];
    return typeof v === 'string' && v.trim().length > 0;
  }

  /** Compute the live status for ONE provider from existing data + env. */
  async statusFor(organizationId: string, spec: ProviderStatusInput): Promise<ProviderStatus> {
    const [connections, recent] = await Promise.all([
      this.integrations.listConnections(organizationId),
      this.integrations.listRecentEvents(organizationId, { provider: spec.providerId, limit: 50 }),
    ]);
    const connection = connections.find((c) => c.provider === spec.providerId) ?? null;

    const secrets: SecretStatus[] = spec.secrets.map((s) => ({
      envVar: s.envVar,
      label: s.label,
      required: s.required,
      configured: IntegrationOsService.isSecretConfigured(s.envVar),
    }));
    const missingRequiredSecrets = secrets
      .filter((s) => s.required && !s.configured)
      .map((s) => s.envVar);
    const allRequiredSecretsConfigured = missingRequiredSecrets.length === 0;
    const secretConfigured = secrets.some((s) => s.required && s.configured) || (secrets.length === 0);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const eventsToday = recent.filter((e) => new Date(e.receivedAt) >= startOfDay).length;
    const eventsProcessed = recent.filter((e) => e.status === 'PROCESSED').length;
    const eventsFailed = recent.filter((e) => e.status === 'FAILED').length;
    const retryQueue = recent.filter(
      (e) => e.status === 'FAILED' || e.status === 'RECEIVED' || e.status === 'PROCESSING',
    );
    const lastEvent = recent[0] ?? null;
    const lastError = recent.find((e) => e.status === 'FAILED') ?? null;
    const lastVerification = readVerification(connection?.config);
    const apiSync = readApiSync(connection?.config);

    const hasAnyProcessed = eventsProcessed > 0 || connection?.status === 'CONNECTED';
    let conn: ConnectionState;
    if (!connection) {
      conn = 'not_configured';
    } else if (hasAnyProcessed) {
      conn = eventsFailed > 0 && eventsProcessed === 0 ? 'error' : 'connected';
    } else if (eventsFailed > 0) {
      conn = 'error';
    } else {
      conn = 'waiting';
    }

    let health: HealthState;
    if (conn === 'not_configured') {
      health = 'unknown';
    } else if (eventsFailed > 0 && eventsProcessed === 0) {
      health = 'down';
    } else if (missingRequiredSecrets.length > 0 || eventsFailed > 0) {
      health = 'degraded';
    } else if (hasAnyProcessed) {
      health = 'healthy';
    } else {
      health = 'unknown';
    }

    // Honest go-live posture. Configuring a secret alone is NEVER 'live'.
    let liveState: LiveState;
    if (spec.planned) {
      liveState = 'not_available';
    } else if (eventsProcessed > 0) {
      liveState = 'live';
    } else if (allRequiredSecretsConfigured) {
      liveState = 'ready_for_setup';
    } else {
      liveState = 'needs_setup';
    }

    const connectionStatusLabel = connection?.status ?? 'NOT_CONFIGURED';
    const webhookActive = spec.hasWebhook && hasAnyProcessed;
    const authVerified = eventsProcessed > 0;

    return {
      providerId: spec.providerId,
      connection: conn,
      connectionStatusLabel,
      health,
      liveState,
      webhookActive,
      authVerified,
      secretConfigured,
      allRequiredSecretsConfigured,
      lastEvent: lastEvent ? toRow(lastEvent) : null,
      lastError: lastError ? toRow(lastError) : null,
      lastVerification,
      apiSync,
      eventsToday,
      eventsProcessed,
      eventsFailed,
      retryQueueDepth: retryQueue.length,
      recentEvents: recent.slice(0, 25).map(toRow),
      retryQueue: retryQueue.map(toRow),
      secrets,
      missingRequiredSecrets,
      connectedAt: connection?.connectedAt ?? null,
      lastSyncedAt: connection?.lastSyncedAt ?? null,
    };
  }

  /** Compute live status for many providers at once. */
  async statusForAll(
    organizationId: string,
    specs: ProviderStatusInput[],
  ): Promise<ProviderStatus[]> {
    return Promise.all(specs.map((s) => this.statusFor(organizationId, s)));
  }
}
