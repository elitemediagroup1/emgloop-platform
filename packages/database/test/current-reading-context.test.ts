import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDomainProducer } from '../src/services/intelligence-fabric/domains/calendar';
import { callgridRule } from '../src/services/intelligence-fabric/domains/callgrid';
import type { DomainKitPorts } from '../src/services/intelligence-fabric/domain-kit';
import type { CallWindowAggregate } from '../src/repositories/marketplace-call.repository';

test('a meeting crossing its end invalidates the fingerprint and gives the model explicit ended context', async () => {
  const seen: unknown[] = [];
  const facts = {
    calendarTimeZone: async () => 'America/New_York',
    calendarEvents: async () => [{ id: 'meeting', startsAt: new Date('2026-10-15T18:00:00Z'), endsAt: new Date('2026-10-15T19:00:00Z'), status: 'confirmed', externalAttendeeCount: 1, attendeeHashes: [], selfResponse: 'accepted', summary: 'Review' }],
    waitingThreadParticipants: async () => [], sentMailTo: async () => true,
  };
  const kit: DomainKitPorts = { modelEnabled: () => true, principalFor: async () => ({ organizationId: 'our-org', userId: 'our-user' }), reader: { read: async (_, req) => { seen.push(...req.context.items.map((i) => JSON.parse(i.content))); return { outcome: 'FAILED', failure: 'TEST' }; } } };
  const p = calendarDomainProducer(facts as never, kit);
  const target = { scope: 'PRINCIPAL' as const, organizationId: 'our-org', userId: 'our-user', domain: 'CALENDAR' as const, subjectKind: 'DOMAIN' as const, subjectRef: 'domain' };
  const before = await p.gather(target, new Date('2026-10-15T18:30:00Z'));
  const after = await p.gather(target, new Date('2026-10-15T19:01:00Z'));
  assert.equal(before.status, 'READY'); assert.equal(after.status, 'READY');
  if (before.status !== 'READY' || after.status !== 'READY') return;
  assert.notEqual(before.fingerprint, after.fingerprint);
  await p.read(target, after.context, after.fingerprint, new Date('2026-10-15T19:01:00Z'));
  assert.ok(seen.some((v) => (v as { phase?: string }).phase === 'ENDED'));
  assert.ok(seen.some((v) => (v as { meetingsRemaining?: number }).meetingsRemaining === 0));
  assert.ok(seen.some((v) => (v as { asOf?: string }).asOf === '2026-10-15T19:01:00.000Z'));
});

test('payout and cost evidence reaches the domain reader independently of full net-profit coverage', () => {
  const aggregate: CallWindowAggregate = { calls: 475, monetized: 148, converted: 0, revenueCents: 296591, payoutCents: 245197, costCents: 6492, callsWithRevenue: 475, callsWithPayout: 475, callsWithCost: 475, buyers: [], vendors: [], sources: [], campaigns: [] };
  const now = new Date('2026-10-16T01:30:00Z');
  const ctx = { current: aggregate, prior: null, lastDayCalls: 475, windowStart: new Date('2026-10-09'), windowEnd: now };
  const full = callgridRule(ctx, now);
  assert.match(full.signals.find((s) => s.key === 'reported-payout')!.statement, /\$2451.97.*475 of 475/);
  assert.match(full.signals.find((s) => s.key === 'reported-telco')!.statement, /\$64.92.*475 of 475/);
  const partial = callgridRule({ ...ctx, current: { ...aggregate, callsWithCost: 470 } }, now);
  assert.match(partial.signals.find((s) => s.key === 'reported-telco')!.statement, /470 of 475/);
  assert.ok(!partial.signals.some((s) => s.key === 'net-profit'));
  assert.ok(partial.limitations.some((s) => /not certification/.test(s)));
});
