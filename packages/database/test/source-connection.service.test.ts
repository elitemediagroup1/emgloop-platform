// SourceConnectionService gating -- pure, no database.
//
// Proves the honest outcomes the Connections surface depends on:
//   - with the default environment (configured=null) NOTHING connects: NOT_CONFIGURED;
//   - a provider absent from the configured set is still NOT_CONFIGURED (Teams live while
//     Telegram is not);
//   - a role without the connection authority is NOT_PERMITTED, and nothing is written;
//   - a live connection cannot be re-opened (ALREADY_CONNECTED) but a RECONNECT_REQUIRED one can;
//   - status is permitted=false when the person may not view, and each tile states truthfully
//     whether it is configured and whether connect/disconnect is offered.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SourceConnectionService } from '../src/services/connections/source-connection.service';
import type { SourceConnectionRepository, SourceConnectionRecord } from '../src/repositories/source-connection.repository';
import type { ConnectionProvider, ConnectionState, BaselineState } from '@emgloop/shared';
import type { SourceBaselineCheckpointRepository } from '../src/repositories/source-baseline.repository';

const PRINCIPAL = { organizationId: 'org1', userId: 'user1', name: 'Tester' };

function record(provider: ConnectionProvider, state: ConnectionState): SourceConnectionRecord {
  return {
    id: `c-${provider}`, organizationId: 'org1', userId: 'user1', provider, adapter: null, state,
    credentialKind: null, accountLabel: null, backgroundObservation: 'UNAVAILABLE', lastFailureClass: null,
    connectingStartedAt: null, connectedAt: null, lastObservedAt: null, reconnectRequiredAt: null,
    disconnectedAt: null, hasCredential: state === 'READY' || state === 'CONNECTED_LIMITED',
  };
}

/** A fake repository that records the calls made against it. */
function fakeRepo(records: SourceConnectionRecord[]) {
  const calls: string[] = [];
  const byProvider = new Map(records.map((r) => [r.provider, r]));
  const repo = {
    async findAll() { return records; },
    async find(_o: string, _u: string, provider: ConnectionProvider) { return byProvider.get(provider) ?? null; },
    async beginConnect(_o: string, _u: string, provider: ConnectionProvider) { calls.push(`begin:${provider}`); return { outcome: 'STARTED' as const, connectionId: 'new' }; },
    async disconnect(_o: string, _u: string, provider: ConnectionProvider) { calls.push(`disconnect:${provider}`); return byProvider.has(provider) ? ('DISCONNECTED' as const) : ('NOTHING_TO_DO' as const); },
  } as unknown as SourceConnectionRepository;
  return { repo, calls };
}

type FakeBaseline = { state: BaselineState; windowDays: number; oldestReachedAt: Date | null };

/** A fake baseline repo. get() returns injected sub-state; the writes validate the window like the real one. */
function fakeBaselines(byProvider: Partial<Record<ConnectionProvider, FakeBaseline>>) {
  const calls: string[] = [];
  const allow = [30, 90, 180, 365];
  const repo = {
    async get(_o: string, _u: string, provider: ConnectionProvider) {
      const b = byProvider[provider];
      return b ? { id: 'cp', organizationId: 'org1', userId: 'user1', provider, windowDays: b.windowDays, windowFloorAt: new Date(0), consentAt: new Date(0), state: b.state, checkpointCursor: null, oldestReachedAt: b.oldestReachedAt, startedAt: null, completedAt: null, lastRunAt: null, lastFailureClass: null, backoffUntil: null, revokedAt: null } : null;
    },
    async authorize(_o: string, _u: string, provider: ConnectionProvider, req: { windowDays: number }) { calls.push(`authorize:${provider}:${req.windowDays}`); return allow.includes(req.windowDays) ? { outcome: 'AUTHORIZED' as const, checkpointId: 'cp' } : { outcome: 'INVALID_WINDOW' as const }; },
    async changeScope(_o: string, _u: string, provider: ConnectionProvider, req: { windowDays: number }) { calls.push(`changeScope:${provider}:${req.windowDays}`); return allow.includes(req.windowDays) ? { outcome: 'SCOPE_CHANGED' as const, checkpointId: 'cp' } : { outcome: 'INVALID_WINDOW' as const }; },
    async revoke(_o: string, _u: string, provider: ConnectionProvider) { calls.push(`revoke:${provider}`); return { outcome: 'REVOKED' as const, checkpointId: 'cp' }; },
  } as unknown as SourceBaselineCheckpointRepository;
  return { repo, calls };
}

function service(opts: { configured: 'none' | ConnectionProvider[]; canView?: boolean; canUpdate?: boolean; records?: SourceConnectionRecord[]; baselines?: Partial<Record<ConnectionProvider, FakeBaseline>> }) {
  const { repo, calls } = fakeRepo(opts.records ?? []);
  const { repo: baselines, calls: baselineCalls } = fakeBaselines(opts.baselines ?? {});
  const configured = opts.configured === 'none' ? null : { providers: new Set(opts.configured) };
  const svc = new SourceConnectionService({} as never, {
    configured,
    connections: repo,
    baselines,
    authorize: async (_p, action) => (action === 'view' ? opts.canView ?? true : opts.canUpdate ?? true),
    now: () => new Date('2026-09-20T00:00:00Z'),
  });
  return { svc, calls, baselineCalls };
}

test('with no configuration, nothing connects', async () => {
  const { svc, calls } = service({ configured: 'none' });
  assert.equal(await svc.beginConnect(PRINCIPAL, 'TELEGRAM'), 'NOT_CONFIGURED');
  assert.equal(await svc.beginConnect(PRINCIPAL, 'MICROSOFT_TEAMS'), 'NOT_CONFIGURED');
  assert.deepEqual(calls, []); // nothing was written
});

test('a provider outside the configured set is NOT_CONFIGURED; one inside it STARTS', async () => {
  const { svc, calls } = service({ configured: ['MICROSOFT_TEAMS'] });
  assert.equal(await svc.beginConnect(PRINCIPAL, 'TELEGRAM'), 'NOT_CONFIGURED');
  assert.equal(await svc.beginConnect(PRINCIPAL, 'MICROSOFT_TEAMS'), 'STARTED');
  assert.deepEqual(calls, ['begin:MICROSOFT_TEAMS']);
});

test('an unknown provider is INVALID', async () => {
  const { svc } = service({ configured: ['TELEGRAM'] });
  assert.equal(await svc.beginConnect(PRINCIPAL, 'SLACK'), 'INVALID');
});

test('without update authority, begin and disconnect are NOT_PERMITTED and write nothing', async () => {
  const { svc, calls } = service({ configured: ['TELEGRAM'], canUpdate: false });
  assert.equal(await svc.beginConnect(PRINCIPAL, 'TELEGRAM'), 'NOT_PERMITTED');
  assert.equal(await svc.disconnect(PRINCIPAL, 'TELEGRAM'), 'NOT_PERMITTED');
  assert.deepEqual(calls, []);
});

test('a live connection is ALREADY_CONNECTED; a RECONNECT_REQUIRED one may reconnect', async () => {
  const live = service({ configured: ['TELEGRAM'], records: [record('TELEGRAM', 'READY')] });
  assert.equal(await live.svc.beginConnect(PRINCIPAL, 'TELEGRAM'), 'ALREADY_CONNECTED');
  assert.deepEqual(live.calls, []);
  const stale = service({ configured: ['TELEGRAM'], records: [record('TELEGRAM', 'RECONNECT_REQUIRED')] });
  assert.equal(await stale.svc.beginConnect(PRINCIPAL, 'TELEGRAM'), 'STARTED');
});

test('disconnect never needs configuration', async () => {
  const { svc } = service({ configured: 'none', records: [record('TELEGRAM', 'READY')] });
  assert.equal(await svc.disconnect(PRINCIPAL, 'TELEGRAM'), 'DISCONNECTED');
});

test('status is refused to a person who may not view', async () => {
  const { svc } = service({ configured: ['TELEGRAM'], canView: false });
  assert.deepEqual(await svc.status(PRINCIPAL), { permitted: false });
});

test('status states, per tile, what is configured and what is offered', async () => {
  const { svc } = service({ configured: ['MICROSOFT_TEAMS'], records: [record('MICROSOFT_TEAMS', 'READY')] });
  const status = await svc.status(PRINCIPAL);
  assert.equal(status.permitted, true);
  if (!status.permitted) return;
  const teams = status.providers.find((p) => p.profile.provider === 'MICROSOFT_TEAMS')!;
  const telegram = status.providers.find((p) => p.profile.provider === 'TELEGRAM')!;
  // Teams: configured, live -> disconnect offered, connect not.
  assert.equal(teams.configured, true);
  assert.equal(teams.state, 'READY');
  assert.equal(teams.canConnect, false);
  assert.equal(teams.canDisconnect, true);
  // Telegram: not configured, no record -> NOT_CONNECTED, neither offered (connect needs config).
  assert.equal(telegram.configured, false);
  assert.equal(telegram.state, 'NOT_CONNECTED');
  assert.equal(telegram.canConnect, false);
  assert.equal(telegram.canDisconnect, false);
});

// --- Governed historical baseline sub-state and actions -----------------------------------------

test('status carries the baseline sub-state per tile, content-free', async () => {
  const { svc } = service({
    configured: ['TELEGRAM'],
    records: [record('TELEGRAM', 'READY')],
    baselines: { TELEGRAM: { state: 'IN_PROGRESS', windowDays: 90, oldestReachedAt: new Date('2026-07-01T00:00:00Z') } },
  });
  const status = await svc.status(PRINCIPAL);
  assert.equal(status.permitted, true);
  if (!status.permitted) return;
  const telegram = status.providers.find((p) => p.profile.provider === 'TELEGRAM')!;
  assert.equal(telegram.baselineState, 'IN_PROGRESS');
  assert.equal(telegram.baselineWindowDays, 90);
  assert.equal(telegram.oldestReachedAt?.toISOString(), '2026-07-01T00:00:00.000Z');
  // A provider with no baseline reads null, never a fabricated default.
  const teams = status.providers.find((p) => p.profile.provider === 'MICROSOFT_TEAMS')!;
  assert.equal(teams.baselineState, null);
  assert.equal(teams.baselineWindowDays, null);
});

test('baseline actions require update authority and reject an unknown provider, writing nothing', async () => {
  const denied = service({ configured: ['TELEGRAM'], canUpdate: false });
  assert.equal(await denied.svc.authorizeBaseline(PRINCIPAL, 'TELEGRAM', 90), 'NOT_PERMITTED');
  assert.equal(await denied.svc.changeBaselineScope(PRINCIPAL, 'TELEGRAM', 90), 'NOT_PERMITTED');
  assert.equal(await denied.svc.revokeBaseline(PRINCIPAL, 'TELEGRAM'), 'NOT_PERMITTED');
  assert.deepEqual(denied.baselineCalls, []); // nothing written when denied

  const ok = service({ configured: ['TELEGRAM'] });
  assert.equal(await ok.svc.authorizeBaseline(PRINCIPAL, 'SLACK', 90), 'INVALID');
  assert.deepEqual(ok.baselineCalls, []); // an unknown provider never reaches the repo
});

test('authorizeBaseline validates the window at the data layer: bounded windows pass, others are INVALID', async () => {
  const { svc, baselineCalls } = service({ configured: ['TELEGRAM'] });
  assert.equal(await svc.authorizeBaseline(PRINCIPAL, 'TELEGRAM', 90), 'AUTHORIZED');
  assert.equal(await svc.authorizeBaseline(PRINCIPAL, 'TELEGRAM', 45), 'INVALID');   // off-allowlist
  assert.equal(await svc.authorizeBaseline(PRINCIPAL, 'TELEGRAM', 99999), 'INVALID'); // no all-time
  // The window is passed through to the repo verbatim (org/user are the principal's, never the input).
  assert.deepEqual(baselineCalls, ['authorize:TELEGRAM:90', 'authorize:TELEGRAM:45', 'authorize:TELEGRAM:99999']);
});

test('changeBaselineScope and revokeBaseline map the repo outcome; revoke never needs configuration', async () => {
  const change = service({ configured: ['TELEGRAM'] });
  assert.equal(await change.svc.changeBaselineScope(PRINCIPAL, 'TELEGRAM', 180), 'SCOPE_CHANGED');
  const revoke = service({ configured: 'none' }); // no configuration
  assert.equal(await revoke.svc.revokeBaseline(PRINCIPAL, 'TELEGRAM'), 'REVOKED');
  assert.deepEqual(revoke.baselineCalls, ['revoke:TELEGRAM']);
});
