import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runFinancialAudit, parseAuditArgs, AUDIT_LIMIT, type AuditDeps } from './audit-callgrid-financials';

const NOW = new Date('2026-10-14T19:00:00Z');
const event = (id = 'call-a', payload: Record<string, unknown> = {}) => ({ externalId: id, rawEventType: 'completed', occurredAt: new Date('2026-10-13T18:00:00Z'), payload: { id, campaign: 'Pest Control', revenue: 1.005, payout: 0.805, ...payload } });
const row = (id = 'call-a') => ({ externalId: id, sourceOccurredAt: new Date('2026-10-13T18:00:00Z'), connectedDurationSeconds: 2, revenueCents: 100, payoutCents: 81, costCents: 4, buyerLabel: null, campaignLabel: 'Pest Control', sourceLabel: null, monetized: true, converted: null, duplicate: null });
const request = { organization: 'fixture-org', date: '2026-10-13', apiKey: 'secret-not-for-output', now: NOW };
function deps(patch: Partial<AuditDeps> = {}): AuditDeps {
  return {
    organizations: { findBySlug: async () => ({ id: 'org1', status: 'ACTIVE' }) },
    calls: { listWindowForReconciliation: async (org, since, until, take, provider) => {
      assert.equal(org, 'org1'); assert.equal(provider, 'callgrid'); assert.equal(take, AUDIT_LIMIT + 1);
      assert.equal(since.toISOString(), '2026-10-13T04:00:00.000Z');
      assert.equal(until.toISOString(), '2026-10-14T04:00:00.000Z'); return [row()];
    } },
    provider: { read: async (input) => { assert.equal(input.maxPages, 100); return { outcome: 'COMPLETE', events: [event()], records: 1, pages: 1, refused: [] }; } },
    ...patch,
  };
}

test('a complete API read with missing cost is inconclusive, never a financial match', async () => {
  const report = await runFinancialAudit(request, deps());
  assert.equal(report.verdict, 'INCONCLUSIVE');
  assert.equal(report.rows[0]!.fields.costCents.status, 'UNKNOWN');
  assert.equal(report.providerCanonicalTotals.fields.costCents.sumReportedCents, null);
  assert.equal(report.providerCanonicalTotals.netProfitOnCompleteCallsCents, null);
  assert.equal(report.rows[0]!.providerDecimalDollars!.revenue, '1.005');
  assert.equal(report.rows[0]!.fields.revenueCents.providerCanonicalCents, 100, 'current production rounding is shown, not silently repaired');
});

test('one-cent differences, missing cost, and call identities survive the report; unrelated payload data does not', async () => {
  const report = await runFinancialAudit(request, deps({ provider: { read: async () => ({ outcome: 'COMPLETE', events: [event('call-a', { revenue: 1.01, cost: 0.12, caller: '+15551234567', transcript: 'private words', token: request.apiKey })], records: 1, pages: 1, refused: [] }) } }));
  assert.equal(report.verdict, 'DIFFERS');
  assert.equal(report.rows[0]!.callId, 'call-a');
  assert.equal(report.rows[0]!.fields.revenueCents.loopMinusProviderCents, -1);
  assert.equal(report.rows[0]!.fields.costCents.loopMinusProviderCents, -8);
  assert.equal(report.rows[0]!.fields.costCents.status, 'MISMATCH');
  assert.doesNotMatch(JSON.stringify(report), /15551234567|private words|secret-not-for-output/);
});

test('truncation, refusals, duplicate IDs, invalid projection and caps cannot claim complete identities', async () => {
  for (const outcome of ['TRUNCATED', 'PROVIDER_ERROR', 'RATE_LIMIT_EXHAUSTED', 'INVALID_PAGINATION', 'REFUSED'] as const) {
    const report = await runFinancialAudit(request, deps({ provider: { read: async () => ({ outcome, events: [], records: 0, pages: 1, refused: [] }) } }));
    assert.equal(report.verdict, 'INCONCLUSIVE');
    assert.equal(report.rows[0]!.identityStatus, 'UNVERIFIED_ABSENCE');
  }
  for (const read of [
    { events: [event(), event()], refused: [] },
    { events: [event()], refused: [{ reason: 'bad' }] },
    { events: [event('', {})], refused: [] },
    { events: [{ ...event(), occurredAt: new Date('2026-10-14T04:00:00Z') }], refused: [] },
  ]) {
    const report = await runFinancialAudit(request, deps({ provider: { read: async () => ({ outcome: 'COMPLETE', ...read, records: 2, pages: 1 }) } }));
    assert.equal(report.verdict, 'INCONCLUSIVE');
  }
  const capped = await runFinancialAudit(request, deps({ calls: { listWindowForReconciliation: async () => Array.from({ length: AUDIT_LIMIT + 1 }, (_, i) => row(`call-${i}`)) } }));
  assert.equal(capped.verdict, 'INCONCLUSIVE'); assert.equal(capped.read.localCapped, true);
});

test('complete differing identity sets are distinguished; missing measurements never become zero', async () => {
  const report = await runFinancialAudit(request, deps({ calls: { listWindowForReconciliation: async () => [row('loop-only')] } }));
  assert.equal(report.verdict, 'DIFFERS');
  assert.deepEqual(report.rows.map((r) => r.identityStatus).sort(), ['LOOP_ONLY', 'PROVIDER_ONLY']);
  assert.ok(report.rows.every((r) => r.fields.revenueCents.status === 'UNKNOWN'));
});

test('a complete known zero is measured; empty data and matching fields have narrowly named verdicts', async () => {
  const report = await runFinancialAudit(request, deps({
    provider: { read: async () => ({ outcome: 'COMPLETE', events: [event('call-a', { revenue: 0, payout: 0, cost: 0 })], records: 1, pages: 1, refused: [] }) },
    calls: { listWindowForReconciliation: async () => [{ ...row(), revenueCents: 0, payoutCents: 0, costCents: 0 }] },
  }));
  assert.equal(report.verdict, 'MATCHED_REPORTED_FIELDS');
  assert.equal(report.providerCanonicalTotals.fields.costCents.sumReportedCents, 0);
  const empty = await runFinancialAudit(request, deps({ provider: { read: async () => ({ outcome: 'COMPLETE', events: [], records: 0, pages: 0, refused: [] }) }, calls: { listWindowForReconciliation: async () => [] } }));
  assert.equal(empty.verdict, 'MATCHED_REPORTED_FIELDS'); assert.equal(empty.loopTotals.calls, 0);
});

test('invalid flags, calendar dates, current days and inactive organizations refuse before provider/local reads', async () => {
  for (const args of [[], ['--organization', 'fixture-org', '--date', '2026-02-30'], ['--organization', 'fixture-org', '--date', '2026-10-13', '--apply', 'true'], ['--organization', 'UPPER', '--date', '2026-10-13']]) assert.throws(() => parseAuditArgs(args));
  const untouched = deps({ organizations: { findBySlug: async () => { throw Error('must not read'); } } });
  await assert.rejects(runFinancialAudit({ ...request, date: '2026-10-14' }, untouched), /COMPLETED_DAY_REQUIRED/);
  await assert.rejects(runFinancialAudit({ ...request, apiKey: '' }, untouched), /INVALID_ENVIRONMENT/);
  const noReads = deps({ organizations: { findBySlug: async () => ({ id: 'foreign', status: 'SUSPENDED' }) }, provider: { read: async () => { throw Error('must not read'); } } });
  await assert.rejects(runFinancialAudit(request, noReads), /ACTIVE_ORGANIZATION_REQUIRED/);
});

test('one Eastern day uses the Time Authority across DST, with the same half-open boundary on both readers', async () => {
  for (const [date, start, end] of [['2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'], ['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z']]) {
    await runFinancialAudit({ ...request, date: date!, now: new Date('2026-12-01') }, deps({ provider: { read: async (input) => { assert.equal(input.since.toISOString(), start); assert.equal(input.until.toISOString(), end); return { outcome: 'COMPLETE', events: [], records: 0, pages: 0, refused: [] }; } }, calls: { listWindowForReconciliation: async (_org, since, until) => { assert.equal(since.toISOString(), start); assert.equal(until.toISOString(), end); return []; } } }));
  }
});

test('runner and workflow expose reads only, never a production write path or a credential in tests/install', () => {
  const runner = readFileSync(new URL('./audit-callgrid-financials.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(runner, /\.(create|update|delete|upsert|execute|ingest|advance|record)\s*\(|\$executeRaw|\$queryRaw|IngestionService|CallGridPollService/);
  const workflow = readFileSync(new URL('../../.github/workflows/audit-callgrid-financials.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/); assert.doesNotMatch(workflow, /\n  (schedule|push|pull_request|workflow_call):/);
  assert.ok(workflow.indexOf('Test the read-only boundary') < workflow.indexOf('secrets.DIRECT_DATABASE_URL'));
  assert.doesNotMatch(workflow, /run:.*\$\{\{ inputs/);
  assert.match(workflow, /retention-days: 7/);
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /vars.ROUTINE_POLL_ORGANIZATIONS/);
  assert.match(runner, /process.env.LOOP_PRISMA_LOG = 'none'/);
});

test('the real repository applies organization, provider and half-open window at the database boundary', async () => {
  const { MarketplaceCallRepository } = await import('../../packages/database/src/repositories/marketplace-call.repository');
  let query: unknown;
  const repo = new MarketplaceCallRepository({ marketplaceCall: { findMany: async (input: unknown) => { query = input; return []; } } } as never);
  const since = new Date('2026-10-13T04:00:00Z');
  const until = new Date('2026-10-14T04:00:00Z');
  await repo.listWindowForReconciliation('authorized-org', since, until, AUDIT_LIMIT + 1, 'callgrid');
  const q = query as { where: unknown; select: Record<string, boolean> };
  assert.deepEqual(q.where, { organizationId: 'authorized-org', provider: 'callgrid', sourceOccurredAt: { gte: since, lt: until } });
  assert.equal(q.select.externalId, true);
  assert.equal(q.select.costCents, true);
  for (const excluded of ['callerPhone', 'metadata', 'payload', 'recordingUrl', 'transcript']) assert.equal(q.select[excluded], undefined);
  await repo.listWindowForReconciliation('another-org', since, until, 5);
  assert.deepEqual((query as { where: unknown }).where, { organizationId: 'another-org', sourceOccurredAt: { gte: since, lt: until } }, 'existing callers keep their scope and behavior');
});

test('the executable fails with a fixed JSON code and never prints credential values', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./audit-callgrid-financials.ts', import.meta.url)), '--apply', 'true'], {
    env: { ...process.env, DATABASE_URL: 'do-not-print-database', CALLGRID_API_KEY: 'do-not-print-api-key' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).verdict, 'FAILED');
  assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-database|do-not-print-api-key/);
});

test('the workflow restricts the shared credential to the already configured organization scope', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/audit-callgrid-financials.yml', import.meta.url), 'utf8');
  const gate = workflow.split('      - name: Restrict the shared provider credential to configured organizations')[1]!.split('      - name: Read financial evidence')[0]!;
  const shell = gate.split('        run: |\n')[1]!.split('\n').map((line) => line.replace(/^          /, '')).join('\n');
  for (const [configured, org, expected] of [['fixture-org, another-org', 'fixture-org', 0], ['', 'fixture-org', 1], ['another-org', 'fixture-org', 1], ['fixture-org', 'fixture-org; echo bypass', 1]] as const) {
    const result = spawnSync('bash', ['-c', shell], { env: { PATH: process.env.PATH, CONFIGURED_ORGANIZATIONS: configured, ORG_SLUG: org }, encoding: 'utf8' });
    assert.equal(result.status, expected);
  }
});
