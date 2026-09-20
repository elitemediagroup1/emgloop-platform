// The connections worker entrypoint. A long-lived staging process that:
//   1. runs an observation sweep on an interval (OBSERVE -> NORMALIZE -> sink), and
//   2. serves the signed control endpoints the Loop web tier calls to drive an interactive
//      Telegram login and to disconnect.
//
// It wires the tested pieces to the live teleproto seam and the database. It is NOT a chat client:
// it observes and normalizes; there is no send/reply/react/history-import anywhere it leads. Secrets
// (api creds, the sealing key, the control secret) come from the environment (Fargate injects them
// from Secrets Manager); none is logged. Message text is never persisted or logged -- only `hadText`.

import {
  ConnectionSecretSealer,
  SourceConnectionRepository,
  prisma,
  type DueConnection,
} from '@emgloop/database';
import type { CapabilityStatus, ConnectionState } from '@emgloop/shared';

import { readWorkerConfig } from './config';
import { createDbObservationSink } from './observation-sink';
import { runObservationSweep, type SweepPorts } from './orchestrator';
import { TelegramAdapter } from './telegram/telegram-adapter';
import { createTelegramClientPort, createTelegramLoginPort } from './telegram/telegram-client';
import { TelegramLoginCoordinator, type TelegramLoginBinding } from './telegram/telegram-login';
import { createControlServer, type ControlHandlers } from './server';

const RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000; // purge the observation store every 6 hours

function log(event: string, fields: Record<string, unknown> = {}): void {
  // Structured, secret-free logging: only ids, counts and states are ever passed in here.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

async function main(): Promise<void> {
  const config = readWorkerConfig();
  const connections = new SourceConnectionRepository(prisma);
  const sealer = new ConnectionSecretSealer(config.connectionSecretKey);
  const sink = createDbObservationSink(prisma);

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

  async function purge(): Promise<void> {
    const cutoff = new Date(Date.now() - config.observationRetentionDays * 24 * 60 * 60 * 1000);
    try {
      const { SourceObservationRepository } = await import('@emgloop/database');
      const { purged } = await new SourceObservationRepository(prisma).purgeOlderThan(cutoff);
      if (purged > 0) log('retention_purge', { purged });
    } catch (err) {
      log('purge_error', { name: (err as Error)?.name ?? 'error' });
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
  void sweep();
  void purge();

  const shutdown = () => {
    clearInterval(sweepTimer);
    clearInterval(purgeTimer);
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
