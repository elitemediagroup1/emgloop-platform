// The Teams/Telegram connection lifecycle for a signed-in person. Private V1.
//
// The Teams/Telegram sibling of GoogleWorkspaceService, arranged the same way: the person is
// ALWAYS the signed session's, authorization and the sealer are injected, and with the default
// environment NOTHING connects -- `configured` is null and every begin is refused as
// NOT_CONFIGURED before anything is written. This is the honest state until a deployment holds the
// provider app credentials AND the durable worker that performs the out-of-band authentication.
//
// WHAT THIS SERVICE DOES, AND WHAT IT DOES NOT. It owns the lifecycle a person drives from the
// Connections surface: what they may see, opening a connect attempt, and disconnecting. It does
// NOT itself talk to Teams or Telegram: the actual authentication (a Microsoft sign-in, a Telegram
// phone-code exchange) and the ongoing observation happen in the durable worker, which resumes the
// sealed credential and calls the runtime (connection-runtime.ts). The service never sees message
// content and never holds a live provider session.

import type { PrismaClient } from '@prisma/client';
import {
  CONNECTION_PROVIDERS,
  connectionIsLive,
  connectionProviderProfile,
  isConnectionProvider,
  type ConnectionActionOutcome,
  type ConnectionProvider,
  type ConnectionProviderProfile,
  type ConnectionState,
} from '@emgloop/shared';

import { SourceConnectionRepository, type SourceConnectionActor } from '../../repositories/source-connection.repository';
import type { ConnectionSecretSealer } from './connection-secret-sealer';

export interface SourceConnectionPrincipal {
  readonly organizationId: string;
  readonly userId: string;
  readonly name?: string | null;
}

export type SourceConnectionAuthority = 'view' | 'update';

export interface SourceConnectionServiceDeps {
  /**
   * Null when this deployment has no worker/app credentials at all: every begin is refused as
   * NOT_CONFIGURED. When present, `providers` is exactly the set that IS configured -- a provider
   * absent from it is still NOT_CONFIGURED, so Teams can be live while Telegram is not.
   */
  readonly configured: { readonly sealer: ConnectionSecretSealer; readonly providers: ReadonlySet<ConnectionProvider> } | null;
  /** The IAM decision for the principal's own connections (`sourceConnections:<action>`). */
  readonly authorize: (principal: SourceConnectionPrincipal, action: SourceConnectionAuthority) => Promise<boolean>;
  readonly now?: () => Date;
  /** The persistence, injectable for tests; the web tier lets it default to the real repository. */
  readonly connections?: SourceConnectionRepository;
}

/** One provider's tile, as the person may see it. Honest: it states what is and is not configured. */
export interface ProviderConnectionView {
  readonly profile: ConnectionProviderProfile;
  readonly configured: boolean;
  readonly state: ConnectionState;
  readonly accountLabel: string | null;
  readonly connectedAt: Date | null;
  readonly lastObservedAt: Date | null;
  readonly reconnectRequiredAt: Date | null;
  readonly disconnectedAt: Date | null;
  readonly canConnect: boolean;
  readonly canDisconnect: boolean;
}

export type SourceConnectionStatus =
  | { readonly permitted: false }
  | { readonly permitted: true; readonly providers: readonly ProviderConnectionView[] };

export class SourceConnectionService {
  private readonly connections: SourceConnectionRepository;
  private readonly now: () => Date;

  constructor(prisma: PrismaClient, private readonly deps: SourceConnectionServiceDeps) {
    this.connections = deps.connections ?? new SourceConnectionRepository(prisma);
    this.now = deps.now ?? (() => new Date());
  }

  private providerConfigured(provider: ConnectionProvider): boolean {
    return this.deps.configured !== null && this.deps.configured.providers.has(provider);
  }

  /** What the person may see about their own connections, one tile per provider. */
  async status(principal: SourceConnectionPrincipal): Promise<SourceConnectionStatus> {
    if (!(await this.deps.authorize(principal, 'view'))) return { permitted: false };
    const [records, canUpdate] = await Promise.all([
      this.connections.findAll(principal.organizationId, principal.userId),
      this.deps.authorize(principal, 'update'),
    ]);
    const byProvider = new Map(records.map((r) => [r.provider, r]));
    const providers = CONNECTION_PROVIDERS.map((provider): ProviderConnectionView => {
      const record = byProvider.get(provider) ?? null;
      const configured = this.providerConfigured(provider);
      const state: ConnectionState = record?.state ?? 'NOT_CONNECTED';
      const live = connectionIsLive(state);
      return {
        profile: connectionProviderProfile(provider),
        configured,
        state,
        accountLabel: record?.accountLabel ?? null,
        connectedAt: record?.connectedAt ?? null,
        lastObservedAt: record?.lastObservedAt ?? null,
        reconnectRequiredAt: record?.reconnectRequiredAt ?? null,
        disconnectedAt: record?.disconnectedAt ?? null,
        // Offer connect only when the person may update, the provider is configured, and nothing is
        // already live; offer disconnect only for a live one. A reconnect is a connect on a
        // RECONNECT_REQUIRED tile, so it reads as "not live" for the connect offer.
        canConnect: canUpdate && configured && !live,
        canDisconnect: canUpdate && live,
      };
    });
    return { permitted: true, providers };
  }

  /**
   * Open a connect attempt for one provider. Honest outcomes only:
   *   INVALID           the request did not name a known provider
   *   NOT_PERMITTED     the person's role does not include a source connection
   *   NOT_CONFIGURED    this deployment cannot connect the provider yet (no app creds / no worker)
   *   ALREADY_CONNECTED a live connection already exists
   *   STARTED           an attempt was opened; the person continues authentication out of band
   *
   * STARTED does NOT mean connected. It records intent and lets the worker pick it up; the person
   * completes a Microsoft sign-in or a Telegram phone-code exchange in the worker, and the worker
   * calls back with a sealed credential (repository.storeCredential). Nothing here fabricates a
   * connection that has not happened.
   */
  async beginConnect(principal: SourceConnectionPrincipal, provider: string): Promise<ConnectionActionOutcome> {
    if (!isConnectionProvider(provider)) return 'INVALID';
    if (!(await this.deps.authorize(principal, 'update'))) return 'NOT_PERMITTED';
    if (!this.providerConfigured(provider)) return 'NOT_CONFIGURED';
    const existing = await this.connections.find(principal.organizationId, principal.userId, provider);
    if (existing && connectionIsLive(existing.state) && existing.state !== 'RECONNECT_REQUIRED') return 'ALREADY_CONNECTED';
    const result = await this.connections.beginConnect(principal.organizationId, principal.userId, provider, {
      actor: this.actor(principal),
      now: this.now(),
    });
    return result.outcome === 'STARTED' ? 'STARTED' : 'NOT_PERMITTED';
  }

  /**
   * End a live connection at the person's request: DISCONNECTED, or NOTHING_TO_DO when there was
   * nothing live. NOT_CONFIGURED never blocks a disconnect -- a person can always sever a connection
   * even in a deployment that could not open a new one.
   */
  async disconnect(principal: SourceConnectionPrincipal, provider: string): Promise<ConnectionActionOutcome> {
    if (!isConnectionProvider(provider)) return 'INVALID';
    if (!(await this.deps.authorize(principal, 'update'))) return 'NOT_PERMITTED';
    const result = await this.connections.disconnect(principal.organizationId, principal.userId, provider, {
      actor: this.actor(principal),
      now: this.now(),
    });
    return result === 'DISCONNECTED' ? 'DISCONNECTED' : 'NOTHING_TO_DO';
  }

  private actor(principal: SourceConnectionPrincipal): SourceConnectionActor {
    return { userId: principal.userId, name: principal.name ?? null };
  }
}
