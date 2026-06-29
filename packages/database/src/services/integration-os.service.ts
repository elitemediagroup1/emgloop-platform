// IntegrationOsService — Sprint 16 (Integration OS, The Connection Layer).
//
// The read-only status engine behind the Integration Center. It derives the
// LIVE operational state of every provider from data EMG Loop already owns:
//   - ProviderConnection rows (connection status, connectedAt, lastSyncedAt)
//   - IntegrationEvent rows  (last event, events today, processed/failed,
//                             retry queue, last error)
//   - process.env presence   (whether a required secret is configured —
//                             BOOLEAN ONLY; values are never read or returned)
//
// It makes NO network calls and stores NO state. The catalog (@emgloop/brain)
// supplies the static spec; this service supplies the live numbers. Together
// they let the Integration Center render cards, health rows, diagnostics and a
// required-configuration checklist for ANY provider without per-provider code.

import type { PrismaClient } from '@prisma/client';
import { IntegrationRepository } from '../repositories/integration.repository';

/** Overall connection posture for a provider. */
export type ConnectionState = 'connected' | 'waiting' | 'error' | 'not_configured';

/** Health rollup for a provider. */
export type HealthState = 'healthy' | 'degraded' | 'down' | 'unknown';

/** Status of a single required secret — presence only, never the value. */
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

/** The full live status snapshot for one provider. */
export interface ProviderStatus {
  providerId: string;
  connection: ConnectionState;
  connectionStatusLabel: string;
  health: HealthState;
  webhookActive: boolean;
  authVerified: boolean;
  lastEvent: EventRow | null;
  lastError: EventRow | null;
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

/** Minimal spec shape this service needs from the catalog (kept local so the
    database package does not hard-depend on the brain package's types). */
export interface ProviderStatusInput {
  providerId: string;
  hasWebhook: boolean;
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

    // Derive connection state. A provider that has received events is
    // connected; one that exists but never delivered is waiting; recent
    // failures with no successes degrade to error; absent = not configured.
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

    // Health rollup: required secrets missing OR only failures => degraded/down.
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

    const connectionStatusLabel = connection?.status ?? 'NOT_CONFIGURED';
    const webhookActive = spec.hasWebhook && hasAnyProcessed;
    // Authentication is considered verified once at least one signed/accepted
    // event has been PROCESSED through the pipeline for this provider.
    const authVerified = eventsProcessed > 0;

    return {
      providerId: spec.providerId,
      connection: conn,
      connectionStatusLabel,
      health,
      webhookActive,
      authVerified,
      lastEvent: lastEvent ? toRow(lastEvent) : null,
      lastError: lastError ? toRow(lastError) : null,
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
