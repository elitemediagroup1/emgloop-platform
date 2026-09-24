// The Teams/Telegram connection lifecycle for a signed-in person. Private V1.
//
// The Teams/Telegram sibling of GoogleWorkspaceService, arranged the same way: the person is
// ALWAYS the signed session's, authorization and the sealer are injected, and with the default
// environment NOTHING connects -- `configured` is null and every begin is refused as
// NOT_CONFIGURED before anything is written. This is the honest state until a deployment holds the
// provider app credentials AND the durable worker that performs the out-of-band authentication.
//
// WHAT THIS SERVICE DOES, AND WHAT IT DOES NOT. It owns the lifecycle a person drives from the
// Connections surface: what they may see, opening a connect attempt, disconnecting, and authorizing
// or revoking a governed HISTORICAL BASELINE (Telegram). It does NOT itself talk to Teams or
// Telegram: the actual authentication and the ongoing observation happen in the durable worker, which
// resumes the sealed credential and calls the runtime. The service never sees message content and
// never holds a live provider session -- and the baseline it authorizes is content-free by construction.

import type { PrismaClient } from '@prisma/client';
import {
  CONNECTION_PROVIDERS,
  connectionIsLive,
  connectionProviderProfile,
  isConnectionProvider,
  type BaselineState,
  type ConnectionActionOutcome,
  type ConnectionProvider,
  type ConnectionProviderProfile,
  type ConnectionState,
  type SourceBaselineActionOutcome,
  type SourceContentActionOutcome,
} from '@emgloop/shared';

import { SourceConnectionRepository, type SourceConnectionActor } from '../../repositories/source-connection.repository';
import { SourceBaselineCheckpointRepository, type BaselineCheckpointRecord } from '../../repositories/source-baseline.repository';
import { SourceContentAuthorizationRepository, type ContentAuthorizationRecord } from '../../repositories/source-content-authorization.repository';

export interface SourceConnectionPrincipal {
  readonly organizationId: string;
  readonly userId: string;
  readonly name?: string | null;
}

export type SourceConnectionAuthority = 'view' | 'update';

export interface SourceConnectionServiceDeps {
  /**
   * Null when this deployment cannot connect any source (no enabled providers, or the worker that
   * runs their authentication is not reachable). When present, `providers` is exactly the set that
   * IS connectable -- a provider absent from it is still NOT_CONFIGURED, so Teams can be live while
   * Telegram is not. The web tier deliberately holds NO session-sealing key: the durable worker
   * seals and opens the per-person session, never this tier.
   */
  readonly configured: { readonly providers: ReadonlySet<ConnectionProvider> } | null;
  /** The IAM decision for the principal's own connections (`sourceConnections:<action>`). */
  readonly authorize: (principal: SourceConnectionPrincipal, action: SourceConnectionAuthority) => Promise<boolean>;
  readonly now?: () => Date;
  /** The persistence, injectable for tests; the web tier lets it default to the real repository. */
  readonly connections?: SourceConnectionRepository;
  /** The baseline checkpoint persistence, injectable for tests; defaults to the real repository. */
  readonly baselines?: SourceBaselineCheckpointRepository;
  /** The content-processing consent persistence, injectable for tests; defaults to the real repository. */
  readonly content?: SourceContentAuthorizationRepository;
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
  /**
   * The governed historical-baseline sub-state, content-free. Null when there is no baseline (or the
   * baseline table could not be read). windowDays is the employee-chosen depth; oldestReachedAt is how
   * far back the walk has reached, for honest progress -- both trace to the checkpoint, never content.
   */
  readonly baselineState: BaselineState | null;
  readonly baselineWindowDays: number | null;
  readonly oldestReachedAt: Date | null;
  /**
   * Whether the employee has authorized CONTENT processing with AI for this source -- a separate
   * consent from connecting and from the history baseline. False when there is none, revoked, or the
   * table could not be read. Never exposes any cursor meaning.
   */
  readonly contentAuthorized: boolean;
}

export type SourceConnectionStatus =
  | { readonly permitted: false }
  | { readonly permitted: true; readonly providers: readonly ProviderConnectionView[] };

export class SourceConnectionService {
  private readonly connections: SourceConnectionRepository;
  private readonly baselines: SourceBaselineCheckpointRepository;
  private readonly content: SourceContentAuthorizationRepository;
  private readonly now: () => Date;

  constructor(prisma: PrismaClient, private readonly deps: SourceConnectionServiceDeps) {
    this.connections = deps.connections ?? new SourceConnectionRepository(prisma);
    this.baselines = deps.baselines ?? new SourceBaselineCheckpointRepository(prisma);
    this.content = deps.content ?? new SourceContentAuthorizationRepository(prisma);
    this.now = deps.now ?? (() => new Date());
  }

  private providerConfigured(provider: ConnectionProvider): boolean {
    return this.deps.configured !== null && this.deps.configured.providers.has(provider);
  }

  /** What the person may see about their own connections, one tile per provider. */
  async status(principal: SourceConnectionPrincipal): Promise<SourceConnectionStatus> {
    if (!(await this.deps.authorize(principal, 'view'))) return { permitted: false };
    const [records, canUpdate, baselines, content] = await Promise.all([
      this.connections.findAll(principal.organizationId, principal.userId),
      this.deps.authorize(principal, 'update'),
      this.readBaselines(principal),
      this.readContent(principal),
    ]);
    const byProvider = new Map(records.map((r) => [r.provider, r]));
    const providers = CONNECTION_PROVIDERS.map((provider): ProviderConnectionView => {
      const record = byProvider.get(provider) ?? null;
      const baseline = baselines.get(provider) ?? null;
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
        baselineState: baseline?.state ?? null,
        baselineWindowDays: baseline?.windowDays ?? null,
        oldestReachedAt: baseline?.oldestReachedAt ?? null,
        contentAuthorized: content.get(provider)?.authorized ?? false,
      };
    });
    return { permitted: true, providers };
  }

  /**
   * The baseline sub-state per provider, read resiliently: a read failure (for example this
   * deployment's web reached its database before the baseline migration did) degrades to nulls so the
   * connection tiles still render, exactly as the page degrades a failed connection read.
   */
  private async readBaselines(principal: SourceConnectionPrincipal): Promise<Map<ConnectionProvider, BaselineCheckpointRecord | null>> {
    const map = new Map<ConnectionProvider, BaselineCheckpointRecord | null>();
    try {
      const records = await Promise.all(
        CONNECTION_PROVIDERS.map((p) => this.baselines.get(principal.organizationId, principal.userId, p)),
      );
      CONNECTION_PROVIDERS.forEach((p, i) => map.set(p, records[i] ?? null));
    } catch {
      for (const p of CONNECTION_PROVIDERS) map.set(p, null);
    }
    return map;
  }

  /**
   * The content-processing consent sub-state per provider, read resiliently: a read failure (for
   * example this deployment's web reached its database before the content migration did) degrades to
   * nulls so the connection tiles still render.
   */
  private async readContent(principal: SourceConnectionPrincipal): Promise<Map<ConnectionProvider, ContentAuthorizationRecord | null>> {
    const map = new Map<ConnectionProvider, ContentAuthorizationRecord | null>();
    try {
      const records = await Promise.all(
        CONNECTION_PROVIDERS.map((p) => this.content.get(principal.organizationId, principal.userId, p)),
      );
      CONNECTION_PROVIDERS.forEach((p, i) => map.set(p, records[i] ?? null));
    } catch {
      for (const p of CONNECTION_PROVIDERS) map.set(p, null);
    }
    return map;
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

  /**
   * Authorize a governed historical baseline at the employee's chosen depth. Same authority as
   * connecting (`sourceConnections:update`); the window is validated at the data layer against the
   * closed allowlist. A baseline never precedes a connection -- NO_CONNECTION when none exists.
   */
  async authorizeBaseline(principal: SourceConnectionPrincipal, provider: string, windowDays: number): Promise<SourceBaselineActionOutcome> {
    if (!isConnectionProvider(provider)) return 'INVALID';
    if (!(await this.deps.authorize(principal, 'update'))) return 'NOT_PERMITTED';
    const result = await this.baselines.authorize(principal.organizationId, principal.userId, provider, {
      windowDays,
      now: this.now(),
      actor: this.actor(principal),
    });
    switch (result.outcome) {
      case 'AUTHORIZED': return 'AUTHORIZED';
      case 'INVALID_WINDOW': return 'INVALID';
      case 'NO_CONNECTION': return 'NO_CONNECTION';
      default: return 'NOT_PERMITTED';
    }
  }

  /** Change the depth of an existing baseline, keeping it resumable. */
  async changeBaselineScope(principal: SourceConnectionPrincipal, provider: string, windowDays: number): Promise<SourceBaselineActionOutcome> {
    if (!isConnectionProvider(provider)) return 'INVALID';
    if (!(await this.deps.authorize(principal, 'update'))) return 'NOT_PERMITTED';
    const result = await this.baselines.changeScope(principal.organizationId, principal.userId, provider, {
      windowDays,
      now: this.now(),
      actor: this.actor(principal),
    });
    switch (result.outcome) {
      case 'SCOPE_CHANGED': return 'SCOPE_CHANGED';
      case 'INVALID_WINDOW': return 'INVALID';
      case 'NOTHING_TO_DO': return 'NOT_IMPORTING';
      case 'NO_CONNECTION': return 'NO_CONNECTION';
      default: return 'NOT_PERMITTED';
    }
  }

  /**
   * Revoke a baseline: stop all further processing immediately. Already-written content-free
   * observations expire via the existing retention policy -- nothing is selectively purged here.
   * NOT_CONFIGURED never blocks a revoke, mirroring disconnect.
   */
  async revokeBaseline(principal: SourceConnectionPrincipal, provider: string): Promise<SourceBaselineActionOutcome> {
    if (!isConnectionProvider(provider)) return 'INVALID';
    if (!(await this.deps.authorize(principal, 'update'))) return 'NOT_PERMITTED';
    const result = await this.baselines.revoke(principal.organizationId, principal.userId, provider, {
      now: this.now(),
      actor: this.actor(principal),
    });
    switch (result.outcome) {
      case 'REVOKED': return 'REVOKED';
      case 'NOTHING_TO_DO': return 'NOT_IMPORTING';
      default: return 'NOT_PERMITTED';
    }
  }

  /**
   * Authorize CONTENT processing for one source: the employee's explicit consent for Loop to read
   * message content transiently and have AI decide whether a new inbound message is meaningfully
   * actionable. Same authority as connecting (`sourceConnections:update`, re-derived from the session).
   * A separate act from connecting and from the history baseline; content consent never precedes a
   * connection -- NO_CONNECTION when none exists.
   */
  async authorizeContent(principal: SourceConnectionPrincipal, provider: string): Promise<SourceContentActionOutcome> {
    if (!isConnectionProvider(provider)) return 'INVALID';
    if (!(await this.deps.authorize(principal, 'update'))) return 'NOT_PERMITTED';
    const result = await this.content.authorize(principal.organizationId, principal.userId, provider, {
      now: this.now(),
      actor: this.actor(principal),
    });
    switch (result.outcome) {
      case 'AUTHORIZED': {
        // v2 conversation triage: when the content-free history baseline is already COMPLETE, arm the
        // one-off HISTORICAL backfill so obligations still unresolved in the already-imported recent
        // window surface without waiting for a new message. The one content consent covers it (no new
        // toggle). Best-effort and idempotent -- it never resets an in-progress or completed backfill,
        // and a failure here never fails the consent the person just gave (forward triage still runs).
        try {
          const baseline = await this.baselines.get(principal.organizationId, principal.userId, provider);
          if (baseline?.state === 'COMPLETE') {
            await this.content.enableHistoricalBackfill(principal.organizationId, principal.userId, provider, {
              floorAt: baseline.windowFloorAt,
            });
          }
        } catch {
          // The backfill is an enhancement over forward triage; if arming it fails, forward triage still runs.
        }
        return 'AUTHORIZED';
      }
      case 'NO_CONNECTION': return 'NO_CONNECTION';
      default: return 'NOT_PERMITTED';
    }
  }

  /**
   * Revoke CONTENT processing: stop all further content processing immediately AND withdraw what it
   * already derived -- the repository closes every open MODEL-produced item for the provider with
   * outcome REVOKED and minimizes every one of them to provenance, in the same transaction as the
   * revoke (§21.2). NOT_CONFIGURED never blocks a revoke, mirroring disconnect and revokeBaseline.
   */
  async revokeContent(principal: SourceConnectionPrincipal, provider: string): Promise<SourceContentActionOutcome> {
    if (!isConnectionProvider(provider)) return 'INVALID';
    if (!(await this.deps.authorize(principal, 'update'))) return 'NOT_PERMITTED';
    const result = await this.content.revoke(principal.organizationId, principal.userId, provider, {
      now: this.now(),
      actor: this.actor(principal),
    });
    switch (result.outcome) {
      case 'REVOKED': return 'REVOKED';
      case 'NOTHING_TO_DO': return 'NOTHING_TO_DO';
      default: return 'NOT_PERMITTED';
    }
  }

  private actor(principal: SourceConnectionPrincipal): SourceConnectionActor {
    return { userId: principal.userId, name: principal.name ?? null };
  }
}
