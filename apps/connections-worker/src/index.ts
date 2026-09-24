// The connections worker entrypoint. A long-lived staging process that:
//   1. runs a live observation sweep on an interval (OBSERVE -> NORMALIZE -> sink),
//   2. runs a GOVERNED HISTORICAL BASELINE sweep on its own interval -- walking each connection's
//      past BACKWARD to an employee-chosen floor, landing the SAME content-free observations on an
//      INDEPENDENT checkpoint (it never advances the live observation cursor),
//   3. runs the retention sweeps every six hours -- content-free observations past the horizon, and
//      the derived (model-produced) work of a connection disconnected past the §21.2 grace window --
//      and
//   4. serves the signed control endpoints the Loop web tier calls to drive an interactive
//      Telegram login and to disconnect.
//
// It wires the tested pieces to the live teleproto seam and the database. It is NOT a chat client:
// it observes and normalizes; there is no send/reply/react and no message content anywhere it leads --
// the baseline imports who/when metadata only. Secrets (api creds, the sealing key, the control secret)
// come from the environment (Fargate injects them from Secrets Manager); none is logged. Message text
// is never persisted or logged -- only `hadText`.

import {
  ConnectionSecretSealer,
  SourceConnectionRepository,
  SourceBaselineCheckpointRepository,
  SourceContentAuthorizationRepository,
  WorkItemRepository,
  prisma,
  type DueConnection,
  type DueBaseline,
  type DueContent,
  type DueHistoricalContent,
} from '@emgloop/database';
import type { CapabilityStatus, ConnectionState } from '@emgloop/shared';

import { readWorkerConfig } from './config';
import { createDbObservationSink } from './observation-sink';
import { runObservationSweep, type SweepPorts } from './orchestrator';
import { runBaselineSweep, type BaselinePorts } from './baseline-orchestrator';
import { runContentSweep, type ContentSweepPorts } from './content-orchestrator';
import { runHistoricalContentSweep, type HistoricalContentSweepPorts } from './historical-content-orchestrator';
import { runDerivedRetentionSweep, type DerivedRetentionPorts } from './derived-retention';
import { createWorkerAiRuntime } from './ai-runtime';
import { TelegramAdapter } from './telegram/telegram-adapter';
import { createTelegramClientPort, createTelegramLoginPort } from './telegram/telegram-client';
import { TelegramLoginCoordinator, type TelegramLoginBinding } from './telegram/telegram-login';
import { createControlServer, type ControlHandlers } from './server';

const RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000; // the retention sweeps (observations, derived work) run every 6 hours

function log(event: string, fields: Record<string, unknown> = {}): void {
  // Structured, secret-free logging: only ids, counts and states are ever passed in here.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

async function main(): Promise<void> {
  const config = readWorkerConfig();
  const connections = new SourceConnectionRepository(prisma);
  const baselines = new SourceBaselineCheckpointRepository(prisma);
  const contentAuthorizations = new SourceContentAuthorizationRepository(prisma);
  const workItems = new WorkItemRepository(prisma);
  const sealer = new ConnectionSecretSealer(config.connectionSecretKey);
  const sink = createDbObservationSink(prisma);

  // The governed AI runtime, assembled from THIS deployment's own env. OFF by default: with
  // LOOP_AI_ENABLED anything but exactly "true", or no listed+confirmed+credentialled provider, it is
  // not enabled and the content sweep never runs -- so no message body is ever read.
  const aiRuntime = createWorkerAiRuntime(prisma);

  const clientPort = createTelegramClientPort(config.telegram);
  const loginPort = createTelegramLoginPort(config.telegram);
  const telegramAdapter = new TelegramAdapter({ port: clientPort, conversationSecret: config.conversationSecret });

  // Session establishment: seal the authorized session and store it as the live credential.
  const coordinator = new TelegramLoginCoordinator({
    port: loginPort,
    async markConnecting(binding) {
      await connections.beginConnect(binding.organizationId, binding.userId, 'TELEGRAM', { actor: { userId: binding.userId }, now: new Date() }).catch(() => undefined);
    },
    async storeAuthorized(binding, authorization) {
      const sealed = sealer.seal(
        { organizationId: binding.organizationId, userId: binding.userId, provider: 'TELEGRAM', credentialKind: 'MTPROTO_SESSION' },
        authorization.session,
      );
      const result = await connections.storeCredential(
        binding.organizationId,
        binding.userId,
        'TELEGRAM',
        { credentialKind: 'MTPROTO_SESSION', adapter: null, accountLabel: authorization.accountLabel, backgroundObservation: authorization.backgroundObservation, sealed, cursor: null, now: new Date() },
        { userId: binding.userId },
      );
      return result.outcome;
    },
  });

  // --- The observation sweep ports -------------------------------------------------------------
  const sweepPorts: SweepPorts = {
    due: () => connections.dueForObservation(500),
    adapterFor: (provider) => (provider === 'TELEGRAM' ? telegramAdapter : null),
    async openCredential(connection: DueConnection): Promise<string | null> {
      const held = await connections.credential(connection.organizationId, connection.userId, connection.provider);
      if (!held || !held.record.credentialKind) return null;
      try {
        return sealer.open(
          { organizationId: connection.organizationId, userId: connection.userId, provider: connection.provider, credentialKind: held.record.credentialKind },
          held.sealed,
        );
      } catch {
        return null; // a credential that will not open is skipped, not guessed
      }
    },
    async recordCycle(connection, outcome: { state: ConnectionState; backgroundObservation: CapabilityStatus; cursor: string | null; failureClass: string | null }) {
      await connections.recordCycle(connection.organizationId, connection.userId, connection.provider, {
        state: outcome.state,
        backgroundObservation: outcome.backgroundObservation,
        cursor: outcome.cursor,
        failureClass: outcome.failureClass,
        now: new Date(),
      });
    },
    sink,
    now: () => new Date(),
  };

  let sweeping = false;
  async function sweep(): Promise<void> {
    if (sweeping) return; // never overlap sweeps
    sweeping = true;
    try {
      const summary = await runObservationSweep(sweepPorts);
      if (summary.due > 0) log('sweep', { ...summary });
    } catch (err) {
      log('sweep_error', { name: (err as Error)?.name ?? 'error' });
    } finally {
      sweeping = false;
    }
  }

  // --- The historical-baseline sweep ports (INDEPENDENT of the live observation sweep) -----------
  // These share the observation sink and the credential opener, but advance ONLY the baseline
  // checkpoint -- never the live observation cursor (SourceConnection.cursor).
  const baselinePorts: BaselinePorts = {
    dueForBaseline: () => baselines.dueForBaseline(500),
    adapterFor: (provider) => (provider === 'TELEGRAM' ? telegramAdapter : null),
    async openCredential(due: DueBaseline): Promise<string | null> {
      const held = await connections.credential(due.organizationId, due.userId, due.provider);
      if (!held || !held.record.credentialKind) return null; // liveness: no live credential, no baseline
      try {
        return sealer.open(
          { organizationId: due.organizationId, userId: due.userId, provider: due.provider, credentialKind: held.record.credentialKind },
          held.sealed,
        );
      } catch {
        return null; // a credential that will not open is skipped, not guessed
      }
    },
    sink,
    async recordBaselineProgress(due, progress) {
      await baselines.recordBaselineProgress(due.organizationId, due.userId, due.provider, {
        checkpointCursor: progress.checkpointCursor,
        oldestReachedAt: progress.oldestReachedAt,
        state: progress.state,
        failureClass: progress.failureClass,
        backoffUntil: progress.backoffUntil,
        now: progress.now,
      });
    },
    maxWindowDays: config.baselineMaxWindowDays,
    pageSize: config.baselinePageSize,
    now: () => new Date(),
  };

  let baselining = false;
  async function baseline(): Promise<void> {
    if (baselining) return; // never overlap baseline sweeps
    baselining = true;
    try {
      const summary = await runBaselineSweep(baselinePorts);
      if (summary.due > 0) log('baseline', { ...summary });
    } catch (err) {
      log('baseline_error', { name: (err as Error)?.name ?? 'error' });
    } finally {
      baselining = false;
    }
  }

  // The credential opener shared by both content sweeps: liveness is enforced here (no live credential,
  // no content), exactly like the live and baseline sweeps.
  async function openContentCredential(due: { organizationId: string; userId: string; provider: DueContent['provider'] }): Promise<string | null> {
    const held = await connections.credential(due.organizationId, due.userId, due.provider);
    if (!held || !held.record.credentialKind) return null;
    try {
      return sealer.open(
        { organizationId: due.organizationId, userId: due.userId, provider: due.provider, credentialKind: held.record.credentialKind },
        held.sealed,
      );
    } catch {
      return null; // a credential that will not open is skipped, not guessed
    }
  }

  // Close obligations a later message answered, WITH the reconcile guard (an anchor outside the evaluated
  // window is left open). Shared by both content sweeps.
  async function resolveObligations(
    principal: { organizationId: string; userId: string },
    subjectRef: string,
    keptAnchorProviderEventIds: readonly string[],
    evaluatedFloorProviderEventId: string,
    occurredAt: Date,
  ): Promise<void> {
    await workItems.resolveObligationsNotIn(principal, subjectRef, keptAnchorProviderEventIds, evaluatedFloorProviderEventId, occurredAt);
  }

  // --- The FORWARD CONTENT-triage sweep ports (INDEPENDENT of the live and baseline sweeps) ------
  // These share the credential opener but have NO port that could write the live observation cursor or
  // the baseline checkpoint -- they advance ONLY the content cursor. Bodies are read transiently, judged
  // by the governed runtime, and dropped; nothing content-bearing is persisted.
  const contentPorts: ContentSweepPorts = {
    dueForContent: () => contentAuthorizations.dueForContent(500),
    adapterFor: (provider) => (provider === 'TELEGRAM' ? telegramAdapter : null),
    openCredential: (due: DueContent) => openContentCredential(due),
    conversationSecret: config.conversationSecret,
    triage: (principal, input) => aiRuntime.service.triage(principal, input),
    async raiseWorkItem(principal, detection) {
      await workItems.detect(principal, detection);
    },
    resolveObligations,
    async recordContentProgress(due, progress) {
      await contentAuthorizations.recordContentProgress(due.organizationId, due.userId, due.provider, {
        contentCursor: progress.contentCursor,
        failureClass: progress.failureClass,
        backoffUntil: progress.backoffUntil,
        now: progress.now,
      });
    },
    contentPageSize: config.contentPageSize,
    contentWindowDays: config.contentWindowDays,
    now: () => new Date(),
  };

  let contentSweeping = false;
  async function content(): Promise<void> {
    if (contentSweeping) return; // never overlap content sweeps
    contentSweeping = true;
    try {
      const summary = await runContentSweep(contentPorts);
      if (summary.due > 0) log('content', { ...summary });
    } catch (err) {
      log('content_error', { name: (err as Error)?.name ?? 'error' });
    } finally {
      contentSweeping = false;
    }
  }

  // --- The HISTORICAL CONTENT-triage backfill ports (INDEPENDENT of every other sweep) -----------
  // These advance ONLY the historical* columns (recordHistoricalProgress) -- there is NO port that could
  // write the live observation cursor, the baseline checkpoint or the forward content cursor. Bodies are
  // read transiently, judged by the governed runtime, and dropped; nothing content-bearing is persisted.
  const historicalContentPorts: HistoricalContentSweepPorts = {
    dueForHistoricalContent: () => contentAuthorizations.dueForHistoricalContent(500),
    adapterFor: (provider) => (provider === 'TELEGRAM' ? telegramAdapter : null),
    openCredential: (due: DueHistoricalContent) => openContentCredential(due),
    conversationSecret: config.conversationSecret,
    triage: (principal, input) => aiRuntime.service.triage(principal, input),
    async raiseWorkItem(principal, detection) {
      await workItems.detect(principal, detection);
    },
    resolveObligations,
    async recordHistoricalProgress(due, progress) {
      await contentAuthorizations.recordHistoricalProgress(due.organizationId, due.userId, due.provider, {
        historicalCursor: progress.historicalCursor,
        state: progress.state,
        oldestReachedAt: progress.oldestReachedAt,
        failureClass: progress.failureClass,
        backoffUntil: progress.backoffUntil,
        failedItemsDelta: progress.failedItemsDelta,
        now: progress.now,
      });
    },
    conversationsPerSweep: config.historicalConversationsPerSweep,
    now: () => new Date(),
  };

  let historicalContentSweeping = false;
  async function historicalContent(): Promise<void> {
    if (historicalContentSweeping) return; // never overlap historical content sweeps
    historicalContentSweeping = true;
    try {
      const summary = await runHistoricalContentSweep(historicalContentPorts);
      if (summary.due > 0) log('historical_content', { ...summary });
    } catch (err) {
      log('historical_content_error', { name: (err as Error)?.name ?? 'error' });
    } finally {
      historicalContentSweeping = false;
    }
  }

  // --- Retention: two independent steps, one cadence -------------------------------------------
  // 1. Content-free observations past the deployment's horizon.
  // 2. DERIVED work (the model's obligations) for a connection disconnected past the §21.2 grace
  //    window: discovery is platform-wide and routing-only; the delete is per principal, scoped and
  //    audited inside the repository, which also refuses a connection that is live again. Counts
  //    only are logged.
  const derivedRetentionPorts: DerivedRetentionPorts = {
    dueForDerivedExpiry: (now) => connections.dueForDerivedExpiry(now, 500),
    expireDerivedWork: (due, now) => connections.expireDerivedWork(due.organizationId, due.userId, due.provider, { now }),
    now: () => new Date(),
  };

  async function purge(): Promise<void> {
    const cutoff = new Date(Date.now() - config.observationRetentionDays * 24 * 60 * 60 * 1000);
    try {
      const { SourceObservationRepository } = await import('@emgloop/database');
      const { purged } = await new SourceObservationRepository(prisma).purgeOlderThan(cutoff);
      if (purged > 0) log('retention_purge', { purged });
    } catch (err) {
      log('purge_error', { name: (err as Error)?.name ?? 'error' });
    }
    try {
      const summary = await runDerivedRetentionSweep(derivedRetentionPorts);
      if (summary.due > 0) log('derived_purge', { ...summary });
    } catch (err) {
      log('derived_purge_error', { name: (err as Error)?.name ?? 'error' });
    }
  }

  // --- Disconnect: revoke at Telegram (best-effort), then clear the stored credential ----------
  async function disconnect(binding: TelegramLoginBinding): Promise<'DISCONNECTED' | 'NOTHING_TO_DO'> {
    const held = await connections.credential(binding.organizationId, binding.userId, 'TELEGRAM');
    if (held && held.record.credentialKind) {
      try {
        const session = sealer.open(
          { organizationId: binding.organizationId, userId: binding.userId, provider: 'TELEGRAM', credentialKind: held.record.credentialKind },
          held.sealed,
        );
        const handle = await clientPort.connectFromSession(session, binding);
        await clientPort.logOut?.(handle);
      } catch {
        // Revocation is best-effort; clearing the stored credential below always happens.
      }
    }
    await loginPort.cancel(binding).catch(() => undefined);
    return connections.disconnect(binding.organizationId, binding.userId, 'TELEGRAM', { actor: { userId: binding.userId }, now: new Date() });
  }

  const handlers: ControlHandlers = {
    startLogin: (binding, phone) => coordinator.start(binding, phone),
    submitCode: (binding, code) => coordinator.submitCode(binding, code),
    submitPassword: (binding, password) => coordinator.submitPassword(binding, password),
    cancelLogin: (binding) => coordinator.cancel(binding),
    disconnect,
  };

  const server = createControlServer({ secret: config.workerControlSecret, handlers });
  server.listen(config.port, () => log('worker_started', { port: config.port, sweepIntervalMs: config.sweepIntervalMs }));

  const sweepTimer = setInterval(() => void sweep(), config.sweepIntervalMs);
  const purgeTimer = setInterval(() => void purge(), RETENTION_SWEEP_MS);
  const baselineTimer = setInterval(() => void baseline(), config.baselineIntervalMs);
  // The content sweep runs ONLY when the governed AI runtime is enabled for this deployment. With AI
  // off (the default everywhere today), no content loop is scheduled and no message body is ever read.
  const contentTimer = aiRuntime.enabled ? setInterval(() => void content(), config.contentIntervalMs) : null;
  // The HISTORICAL backfill sweep runs ONLY when the governed AI runtime is enabled, exactly like the
  // forward content sweep. With AI off (the default everywhere today), no historical loop is scheduled and
  // no message body is ever read.
  const historicalContentTimer = aiRuntime.enabled ? setInterval(() => void historicalContent(), config.historicalContentIntervalMs) : null;
  log('ai_runtime', { contentTriage: aiRuntime.enabled ? 'enabled' : 'off' });
  void sweep();
  void purge();
  void baseline();
  if (aiRuntime.enabled) void content();
  if (aiRuntime.enabled) void historicalContent();

  const shutdown = () => {
    clearInterval(sweepTimer);
    clearInterval(purgeTimer);
    clearInterval(baselineTimer);
    if (contentTimer) clearInterval(contentTimer);
    if (historicalContentTimer) clearInterval(historicalContentTimer);
    server.close();
    void prisma.$disconnect();
    log('worker_stopping');
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Only run when executed directly (not when imported by a test).
if (process.env.LOOP_CONNECTIONS_WORKER_RUN === '1') {
  main().catch((err) => {
    log('worker_fatal', { name: (err as Error)?.name ?? 'error' });
    process.exitCode = 1;
  });
}

export { main };
