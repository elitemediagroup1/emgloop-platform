// Provider reconciliation — did what the provider held actually arrive?
//
// THE PROPERTY UNDER TEST, ONCE
//
// A comparison may only produce a verdict when its own evidence is sound, and
// every count it stores must add up. Each case below is a way that could fail: a
// truncated read reported as a complete one, a local row silently dropped because
// its occurrence would not parse, a record attributed to nothing, an absence
// classified against a declaration that was not in force on that date, or one
// organization's calls answering another organization's question.
//
// The counter-property matters just as much: a campaign that was never connected
// must NOT make the day a failure, and a campaign that delivers must not have its
// one missing call hidden inside the same total.
//
// AUGUST 5 IS THE REGRESSION. 974 provider identities, 867 local, 107 absent
// across four campaigns and five that reconciled — reproduced from generic
// fixtures, with the day's state deriving from the DECLARATIONS supplied and not
// from any campaign name.
//
// Everything runs on the in-memory Prisma double and injected provider/local
// seams. No database, no network, no clock of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECONCILIATION_RULE_VERSION,
  easternBusinessDayWindow,
  type BusinessDate,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { ProviderMemberExpectationRepository } from '../src/repositories/provider-member-expectation.repository';
import {
  INTEGRATION_EVENT_STAGE,
  ProviderReconciliationRepository,
  type RecordReconciliationInput,
} from '../src/repositories/provider-reconciliation.repository';
import { businessDateToColumn } from '../src/repositories/provider-observation.repository';
import {
  LOCAL_SCAN_MARGIN_MS,
  ProviderReconciliationService,
  memberIdFrom,
  memberLabelFrom,
  type LocalDeliveryReader,
  type LocalDeliveryRecord,
  type ProviderPopulationReader,
  type ProviderPopulationRecord,
} from '../src/services/provider-reconciliation.service';
import { CALLGRID_PROVIDER, CALLS_STREAM } from '../src/services/provider-observation.service';

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';
const DAY: BusinessDate = '2026-08-05';
const NOW = new Date('2026-08-19T12:00:00.000Z');

// Generic fixture members. No business name and no real campaign id anywhere:
// the day's state must derive from the declarations supplied, never from which
// campaign an identifier happens to name.
const M_SILENT = 'cmp-silent';      // large population, nothing arrived
const M_SPANISH = 'cmp-unwired-a';  // small population, nothing arrived
const M_INTERNAL = 'cmp-unwired-b'; // small population, nothing arrived
const M_DELIVERING = 'cmp-delivering'; // delivers, one identity short
const M_CLEAN = 'cmp-clean';        // fully reconciled

const WINDOW = easternBusinessDayWindow(DAY);
/** Mid-window, so a fixture never sits on a boundary by accident. */
const MID = new Date(WINDOW.start.getTime() + 6 * 60 * 60 * 1000);

function providerRecord(
  identity: string,
  memberExternalId: string | null,
  label: string | null = null,
): ProviderPopulationRecord {
  return { identity, memberExternalId, label };
}

function localRecord(
  identity: string | null,
  memberExternalId: string | null,
  occurredAt: Date | null = MID,
): LocalDeliveryRecord {
  return { identity, occurredAt, memberExternalId };
}

interface Harness {
  prisma: ReturnType<typeof makeCognitivePrisma>;
  service: ProviderReconciliationService;
  reconciliations: ProviderReconciliationRepository;
  expectations: ProviderMemberExpectationRepository;
  providerCalls: number;
}

function harness(options: {
  provider: readonly ProviderPopulationRecord[];
  local: readonly LocalDeliveryRecord[];
  truncated?: boolean;
  recordsFetched?: number;
  pagesFetched?: number;
}): Harness {
  const prisma = makeCognitivePrisma();
  const reconciliations = new ProviderReconciliationRepository(prisma as never);
  const expectations = new ProviderMemberExpectationRepository(prisma as never);
  const state = { providerCalls: 0 };

  const providerReader: ProviderPopulationReader = {
    async enumerate() {
      state.providerCalls += 1;
      return {
        records: [...options.provider],
        recordsFetched: options.recordsFetched ?? options.provider.length,
        pagesFetched: options.pagesFetched ?? 1,
        pageCap: 100,
        truncated: options.truncated === true,
      };
    },
  };
  const localReader: LocalDeliveryReader = {
    async read() {
      return [...options.local];
    },
  };
  const service = new ProviderReconciliationService(prisma as never, {
    reconciliations,
    expectations,
    providerReader,
    localReader,
  });
  return {
    prisma,
    service,
    reconciliations,
    expectations,
    get providerCalls() {
      return state.providerCalls;
    },
  };
}

async function declare(
  expectations: ProviderMemberExpectationRepository,
  organizationId: string,
  memberExternalId: string,
  declaredState: 'EXPECTED' | 'NOT_CONFIGURED' | 'EXCLUDED',
  over: { effectiveFrom?: BusinessDate; effectiveTo?: BusinessDate | null } = {},
): Promise<string> {
  const result = await expectations.declare(organizationId, {
    provider: CALLGRID_PROVIDER,
    stream: CALLS_STREAM,
    dimension: 'CAMPAIGN',
    memberExternalId,
    state: declaredState,
    exclusionReason: declaredState === 'EXCLUDED' ? 'INTERNAL_TRAFFIC' : null,
    basis: 'PROVIDER_CONFIG_VERIFIED',
    reason: 'Fixture declaration.',
    effectiveFrom: over.effectiveFrom ?? '2026-01-01',
    effectiveTo: over.effectiveTo ?? null,
  });
  assert.equal(result.ok, true, 'fixture declaration must be accepted');
  return result.ok ? result.declaration.id : '';
}

function run(h: Harness, over: Partial<{ businessDate: BusinessDate; pageCap: number }> = {}) {
  return h.service.reconcileDay({
    organizationId: ORG,
    businessDate: over.businessDate ?? DAY,
    apiKey: 'test-key',
    now: NOW,
    ...(over.pageCap ? { pageCap: over.pageCap } : {}),
  });
}

/**
 * A well-formed, entirely empty day, so a test asserting ONE invariant does not
 * have to restate thirty counts that are not the point of it.
 */
function emptyDayInput(over: Partial<RecordReconciliationInput> = {}): RecordReconciliationInput {
  return {
    provider: CALLGRID_PROVIDER,
    stream: CALLS_STREAM,
    businessDate: DAY,
    timezone: 'America/New_York',
    windowStart: WINDOW.start,
    windowEnd: WINDOW.end,
    scanStart: WINDOW.start,
    scanEnd: WINDOW.end,
    state: 'RECONCILED',
    ruleVersion: RECONCILIATION_RULE_VERSION,
    localStage: INTEGRATION_EVENT_STAGE,
    counts: {
      providerUnique: 0, providerDuplicateIds: 0, localUnique: 0, localDuplicateIds: 0,
      intersection: 0, providerOnly: 0, localOnly: 0,
      providerOnlyExpected: 0, providerOnlyNotConfigured: 0, providerOnlyExcluded: 0,
      providerOnlyUnknownMember: 0,
    },
    evidence: {
      providerRecords: 0, providerUnattributed: 0, localRowsScanned: 0, localInWindow: 0,
      localUnresolvedOccurrence: 0, localMissingIdentity: 0, pagesFetched: 1, pageCap: 100,
      truncated: false,
    },
    members: [],
    reason: null,
    observedAt: NOW,
    reconciledAt: NOW,
    ...over,
  };
}

// --- State derivation ---------------------------------------------------------

test('a perfect identity match reconciles', async () => {
  const h = harness({
    provider: [providerRecord('a', M_CLEAN), providerRecord('b', M_CLEAN)],
    local: [localRecord('a', M_CLEAN), localRecord('b', M_CLEAN)],
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'RECONCILED');
  assert.equal(result.day.counts.intersection, 2);
  assert.equal(result.day.counts.providerOnly, 0);
  assert.equal(result.day.counts.localOnly, 0);
  assert.equal(result.day.reason, null);
});

test('an EXPECTED member missing identities is UNRECONCILED', async () => {
  const h = harness({
    provider: [providerRecord('a', M_DELIVERING), providerRecord('b', M_DELIVERING)],
    local: [localRecord('a', M_DELIVERING)],
  });
  await declare(h.expectations, ORG, M_DELIVERING, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'UNRECONCILED');
  assert.equal(result.day.counts.providerOnlyExpected, 1);
});

test('NOT_CONFIGURED absences still RECONCILE — a campaign that was never connected has not failed', async () => {
  const h = harness({
    provider: [providerRecord('a', M_SPANISH), providerRecord('b', M_CLEAN)],
    local: [localRecord('b', M_CLEAN)],
  });
  await declare(h.expectations, ORG, M_SPANISH, 'NOT_CONFIGURED');
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'RECONCILED');
  assert.equal(result.day.counts.providerOnlyNotConfigured, 1);
  assert.equal(result.day.counts.providerOnlyExpected, 0);
  // Counted, never subtracted: the absence is still visible in the total.
  assert.equal(result.day.counts.providerOnly, 1);
});

test('EXCLUDED absences behave the same way, and are still counted', async () => {
  const h = harness({
    provider: [providerRecord('a', M_INTERNAL), providerRecord('b', M_CLEAN)],
    local: [localRecord('b', M_CLEAN)],
  });
  await declare(h.expectations, ORG, M_INTERNAL, 'EXCLUDED');
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'RECONCILED');
  assert.equal(result.day.counts.providerOnlyExcluded, 1);
  assert.equal(result.day.counts.providerOnly, 1);
});

test('an undeclared member carrying absences is UNKNOWN_EXPECTATION', async () => {
  const h = harness({
    provider: [providerRecord('a', M_SILENT), providerRecord('b', M_CLEAN)],
    local: [localRecord('b', M_CLEAN)],
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'UNKNOWN_EXPECTATION');
  assert.equal(result.day.counts.providerOnlyUnknownMember, 1);
  const member = result.day.members.find((m) => m.memberExternalId === M_SILENT);
  assert.equal(member?.expectationState, 'UNKNOWN');
  assert.equal(member?.expectationId, null);
});

test('UNKNOWN_EXPECTATION outranks UNRECONCILED — an unbounded question beats a bounded defect', async () => {
  const h = harness({
    provider: [
      providerRecord('a', M_SILENT),
      providerRecord('b', M_DELIVERING),
      providerRecord('c', M_DELIVERING),
    ],
    local: [localRecord('c', M_DELIVERING)],
  });
  await declare(h.expectations, ORG, M_DELIVERING, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'UNKNOWN_EXPECTATION');
  assert.equal(result.day.counts.providerOnlyExpected, 1);
  assert.equal(result.day.counts.providerOnlyUnknownMember, 1);
});

test('one EXPECTED member short and one NOT_CONFIGURED member short is UNRECONCILED', async () => {
  const h = harness({
    provider: [
      providerRecord('a', M_SPANISH),
      providerRecord('b', M_DELIVERING),
      providerRecord('c', M_DELIVERING),
    ],
    local: [localRecord('c', M_DELIVERING)],
  });
  await declare(h.expectations, ORG, M_SPANISH, 'NOT_CONFIGURED');
  await declare(h.expectations, ORG, M_DELIVERING, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'UNRECONCILED');
  assert.equal(result.day.counts.providerOnlyExpected, 1);
  assert.equal(result.day.counts.providerOnlyNotConfigured, 1);
});

// --- Evidence integrity -------------------------------------------------------

test('a truncated provider read is INCONCLUSIVE, and says so', async () => {
  const h = harness({
    provider: [providerRecord('a', M_CLEAN)],
    local: [localRecord('a', M_CLEAN)],
    truncated: true,
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Everything else about this day is perfect. Truncation alone decides it.
  assert.equal(result.day.state, 'INCONCLUSIVE');
  assert.equal(result.day.evidence.truncated, true);
  assert.match(String(result.day.reason), /page budget/);
});

test('records Loop holds that the provider did not return are INCONCLUSIVE, not UNRECONCILED', async () => {
  const h = harness({
    provider: [providerRecord('a', M_CLEAN)],
    local: [localRecord('a', M_CLEAN), localRecord('rogue', M_CLEAN)],
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'INCONCLUSIVE');
  assert.equal(result.day.counts.localOnly, 1);
});

test('a provider record carrying no member attribution is INCONCLUSIVE and is never invented a member', async () => {
  const h = harness({
    provider: [providerRecord('a', null), providerRecord('b', M_CLEAN)],
    local: [localRecord('b', M_CLEAN)],
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'INCONCLUSIVE');
  assert.equal(result.day.evidence.providerUnattributed, 1);
  // Counted honestly in the split so the arithmetic still holds...
  assert.equal(result.day.counts.providerOnlyUnknownMember, 1);
  // ...and NOT turned into a member row with a fabricated id.
  assert.deepEqual(
    result.day.members.map((m) => m.memberExternalId).sort(),
    [M_CLEAN],
  );
});

test('a local row whose occurrence cannot be resolved impeaches the day', async () => {
  const h = harness({
    provider: [providerRecord('a', M_CLEAN)],
    local: [localRecord('a', M_CLEAN), localRecord('b', M_CLEAN, null)],
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'INCONCLUSIVE');
  assert.equal(result.day.evidence.localUnresolvedOccurrence, 1);
  assert.match(String(result.day.reason), /no resolvable occurrence/);
});

test('a local row in the window with no identity impeaches the day', async () => {
  const h = harness({
    provider: [providerRecord('a', M_CLEAN)],
    local: [localRecord('a', M_CLEAN), localRecord(null, M_CLEAN)],
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'INCONCLUSIVE');
  assert.equal(result.day.evidence.localMissingIdentity, 1);
});

test('two identity sets that barely overlap are incoherent, not "everything is missing"', async () => {
  // Ten each side, one shared: far below the coherence floor. Reporting nine
  // absences here would be a false alarm about a mapping defect.
  const provider = Array.from({ length: 10 }, (_, i) => providerRecord(`p${i}`, M_CLEAN));
  const local = [localRecord('p0', M_CLEAN), ...Array.from({ length: 9 }, (_, i) => localRecord(`l${i}`, M_CLEAN))];
  const h = harness({ provider, local });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'INCONCLUSIVE');
  assert.match(String(result.day.reason), /overlap too little/);
});

// --- Empty and quiet days -----------------------------------------------------

test('a genuinely empty day reconciles — a proven zero is not a defect', async () => {
  const h = harness({ provider: [], local: [] });
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'RECONCILED');
  assert.equal(result.day.counts.providerUnique, 0);
  assert.equal(result.day.counts.localUnique, 0);
  assert.equal(result.day.members.length, 0);
});

test('nothing from the provider but records held locally is INCONCLUSIVE', async () => {
  const h = harness({ provider: [], local: [localRecord('a', M_CLEAN)] });
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'INCONCLUSIVE');
  assert.equal(result.day.counts.localOnly, 1);
});

// --- Duplicates ---------------------------------------------------------------

test('a repeated provider identity is counted, and does not by itself break reconciliation', async () => {
  const h = harness({
    provider: [providerRecord('a', M_CLEAN), providerRecord('a', M_CLEAN), providerRecord('b', M_CLEAN)],
    local: [localRecord('a', M_CLEAN), localRecord('b', M_CLEAN)],
    recordsFetched: 3,
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'RECONCILED');
  assert.equal(result.day.counts.providerUnique, 2);
  assert.equal(result.day.counts.providerDuplicateIds, 1);
  assert.equal(result.day.evidence.providerRecords, 3);
  // The member is counted once, from the identity set rather than the row count.
  const member = result.day.members.find((m) => m.memberExternalId === M_CLEAN);
  assert.equal(member?.providerCount, 2);
});

test('a repeated local identity is counted, and does not by itself break reconciliation', async () => {
  const h = harness({
    provider: [providerRecord('a', M_CLEAN)],
    local: [localRecord('a', M_CLEAN), localRecord('a', M_CLEAN)],
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'RECONCILED');
  assert.equal(result.day.counts.localUnique, 1);
  assert.equal(result.day.counts.localDuplicateIds, 1);
  assert.equal(result.day.evidence.localInWindow, 2);
});

// --- Windows and late deliveries ---------------------------------------------

test('a webhook delivered days late still belongs to the day it occurred on', async () => {
  const h = harness({
    provider: [providerRecord('a', M_CLEAN)],
    // The scan reaches wider than the day; the record is judged by OCCURRENCE.
    local: [localRecord('a', M_CLEAN, MID)],
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'RECONCILED');
  // The stored scan bound is wider than the occurrence window, and says so.
  const day = await h.reconciliations.findDay(ORG, CALLGRID_PROVIDER, CALLS_STREAM, DAY);
  assert.ok(day);
});

test('a record that occurred outside the Eastern day is not local evidence for it', async () => {
  const beforeStart = new Date(WINDOW.start.getTime() - 60 * 1000);
  const h = harness({
    provider: [providerRecord('a', M_CLEAN)],
    local: [localRecord('a', M_CLEAN, beforeStart)],
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // The identity exists locally but not on this day, so it is genuinely absent.
  assert.equal(result.day.counts.localUnique, 0);
  assert.equal(result.day.counts.providerOnly, 1);
  assert.equal(result.day.state, 'UNRECONCILED');
});

test('the window is half-open — a record exactly at the end belongs to the NEXT day', async () => {
  const h = harness({
    provider: [providerRecord('a', M_CLEAN)],
    local: [localRecord('a', M_CLEAN, WINDOW.end)],
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.counts.localUnique, 0);
});

test('a record exactly at the start of the window belongs to this day', async () => {
  const h = harness({
    provider: [providerRecord('a', M_CLEAN)],
    local: [localRecord('a', M_CLEAN, WINDOW.start)],
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'RECONCILED');
});

test('the stored scan window is wider than the occurrence window, in both directions', async () => {
  const h = harness({ provider: [], local: [] });
  await run(h);
  const row = h.prisma.providerReconciliationDay.__rows[0];
  assert.equal(row.windowStart.getTime(), WINDOW.start.getTime());
  assert.equal(row.windowEnd.getTime(), WINDOW.end.getTime());
  assert.equal(row.scanStart.getTime(), WINDOW.start.getTime() - LOCAL_SCAN_MARGIN_MS);
  assert.equal(row.scanEnd.getTime(), WINDOW.end.getTime() + LOCAL_SCAN_MARGIN_MS);
});

// --- Expectation resolution ---------------------------------------------------

test('the declaration in force ON THE BUSINESS DATE is used, not the current one', async () => {
  const h = harness({
    provider: [providerRecord('a', M_SPANISH), providerRecord('b', M_CLEAN)],
    local: [localRecord('b', M_CLEAN)],
  });
  // Not connected until two weeks AFTER the day being reconciled. Attaching the
  // webhook later must not retroactively convert this day into a failure.
  await declare(h.expectations, ORG, M_SPANISH, 'NOT_CONFIGURED', { effectiveTo: '2026-08-19' });
  await declare(h.expectations, ORG, M_SPANISH, 'EXPECTED', { effectiveFrom: '2026-08-19' });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'RECONCILED');
  assert.equal(result.day.counts.providerOnlyNotConfigured, 1);
});

test('the member row names the declaration it used, so a later declaration cannot rewrite history', async () => {
  const h = harness({
    provider: [providerRecord('a', M_DELIVERING), providerRecord('b', M_DELIVERING)],
    local: [localRecord('a', M_DELIVERING)],
  });
  const declarationId = await declare(h.expectations, ORG, M_DELIVERING, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const member = result.day.members.find((m) => m.memberExternalId === M_DELIVERING);
  assert.equal(member?.expectationId, declarationId);
  assert.equal(member?.expectationMatches, 1);
});

test('a member with no declaration resolves UNKNOWN and names no declaration', async () => {
  const h = harness({
    provider: [providerRecord('a', M_SILENT)],
    local: [localRecord('a', M_SILENT)],
  });
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Nothing is missing, so the day still reconciles — UNKNOWN only blocks when
  // the member is actually carrying an absence.
  assert.equal(result.day.state, 'RECONCILED');
  const member = result.day.members.find((m) => m.memberExternalId === M_SILENT);
  assert.equal(member?.expectationState, 'UNKNOWN');
  assert.equal(member?.expectationId, null);
});

test('a member that delivered nothing at all is still assessed, not silently absent', async () => {
  const h = harness({
    provider: [providerRecord('a', M_SILENT), providerRecord('b', M_SILENT)],
    local: [],
  });
  await declare(h.expectations, ORG, M_SILENT, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const member = result.day.members.find((m) => m.memberExternalId === M_SILENT);
  assert.equal(member?.providerCount, 2);
  assert.equal(member?.providerOnly, 2);
  assert.equal(member?.localCount, 0);
  assert.equal(result.day.state, 'UNRECONCILED');
});

// --- Tenancy ------------------------------------------------------------------

test("another organization's declaration cannot answer this organization's question", async () => {
  const h = harness({
    provider: [providerRecord('a', M_SPANISH), providerRecord('b', M_CLEAN)],
    local: [localRecord('b', M_CLEAN)],
  });
  // Declared for the OTHER tenant only.
  await declare(h.expectations, OTHER_ORG, M_SPANISH, 'NOT_CONFIGURED');
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.state, 'UNKNOWN_EXPECTATION');
  assert.equal(result.day.counts.providerOnlyNotConfigured, 0);
  assert.equal(result.day.counts.providerOnlyUnknownMember, 1);
});

test("another organization's reconciliation for the same day is a separate row", async () => {
  const h = harness({
    provider: [providerRecord('a', M_CLEAN)],
    local: [localRecord('a', M_CLEAN)],
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  await run(h);
  await h.service.reconcileDay({
    organizationId: OTHER_ORG,
    businessDate: DAY,
    apiKey: 'test-key',
    now: NOW,
  });
  assert.equal(h.prisma.providerReconciliationDay.__rows.length, 2);
  const mine = await h.reconciliations.findDay(ORG, CALLGRID_PROVIDER, CALLS_STREAM, DAY);
  const theirs = await h.reconciliations.findDay(OTHER_ORG, CALLGRID_PROVIDER, CALLS_STREAM, DAY);
  assert.equal(mine?.state, 'RECONCILED');
  assert.equal(theirs?.state, 'RECONCILED');
});

test("a member's facts are not readable through another organization", async () => {
  const h = harness({
    provider: [providerRecord('a', M_CLEAN)],
    local: [localRecord('a', M_CLEAN)],
  });
  await run(h);
  const mine = await h.reconciliations.memberFactsForDates(
    ORG, CALLGRID_PROVIDER, CALLS_STREAM, 'CAMPAIGN', M_CLEAN, [DAY],
  );
  const theirs = await h.reconciliations.memberFactsForDates(
    OTHER_ORG, CALLGRID_PROVIDER, CALLS_STREAM, 'CAMPAIGN', M_CLEAN, [DAY],
  );
  assert.equal(mine.size, 1);
  assert.equal(theirs.size, 0);
});

test('a cross-organization day is not-found, never another tenant’s answer', async () => {
  const h = harness({ provider: [], local: [] });
  await run(h);
  assert.equal(await h.reconciliations.findDay(OTHER_ORG, CALLGRID_PROVIDER, CALLS_STREAM, DAY), null);
  const states = await h.reconciliations.statesForDates(OTHER_ORG, CALLGRID_PROVIDER, CALLS_STREAM, [DAY]);
  assert.equal(states.size, 0);
});

// --- Idempotency and rerun ----------------------------------------------------

test('re-running an unchanged day converges on ONE row rather than accumulating', async () => {
  const h = harness({
    provider: [providerRecord('a', M_CLEAN)],
    local: [localRecord('a', M_CLEAN)],
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const first = await run(h);
  const second = await run(h);
  assert.equal(first.ok && second.ok, true);
  assert.equal(h.prisma.providerReconciliationDay.__rows.length, 1);
  assert.equal(h.prisma.providerReconciliationMember.__rows.length, 1);
  if (first.ok && second.ok) assert.equal(first.day.state, second.day.state);
});

test('a member that stopped appearing does not linger from the previous run', async () => {
  const prisma = makeCognitivePrisma();
  const reconciliations = new ProviderReconciliationRepository(prisma as never);
  const expectations = new ProviderMemberExpectationRepository(prisma as never);
  let population: ProviderPopulationRecord[] = [
    providerRecord('a', M_CLEAN),
    providerRecord('b', M_SILENT),
  ];
  let localRows: LocalDeliveryRecord[] = [localRecord('a', M_CLEAN), localRecord('b', M_SILENT)];
  const service = new ProviderReconciliationService(prisma as never, {
    reconciliations,
    expectations,
    providerReader: {
      async enumerate() {
        return { records: [...population], recordsFetched: population.length, pagesFetched: 1, pageCap: 100, truncated: false };
      },
    },
    localReader: { async read() { return [...localRows]; } },
  });

  await service.reconcileDay({ organizationId: ORG, businessDate: DAY, apiKey: 'k', now: NOW });
  assert.equal(prisma.providerReconciliationMember.__rows.length, 2);

  // The provider stops reporting one campaign entirely, and so does Loop.
  population = [providerRecord('a', M_CLEAN)];
  localRows = [localRecord('a', M_CLEAN)];
  const again = await service.reconcileDay({ organizationId: ORG, businessDate: DAY, apiKey: 'k', now: NOW });
  assert.equal(again.ok, true);
  assert.equal(prisma.providerReconciliationMember.__rows.length, 1);
  if (again.ok) assert.deepEqual(again.day.members.map((m) => m.memberExternalId), [M_CLEAN]);
});

test('re-running after a declaration is recorded changes the verdict, deliberately', async () => {
  const h = harness({
    provider: [providerRecord('a', M_SPANISH), providerRecord('b', M_CLEAN)],
    local: [localRecord('b', M_CLEAN)],
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  const before = await run(h);
  assert.equal(before.ok && before.day.state, 'UNKNOWN_EXPECTATION');

  await declare(h.expectations, ORG, M_SPANISH, 'NOT_CONFIGURED');
  const after = await run(h);
  assert.equal(after.ok, true);
  if (!after.ok) return;
  // A person answered the question, and re-running is what applies the answer.
  // The old verdict is replaced rather than kept alongside.
  assert.equal(after.day.state, 'RECONCILED');
  assert.equal(h.prisma.providerReconciliationDay.__rows.length, 1);
});

test('reconciling a different day writes a different row', async () => {
  const h = harness({ provider: [], local: [] });
  await run(h);
  await run(h, { businessDate: '2026-08-06' });
  assert.equal(h.prisma.providerReconciliationDay.__rows.length, 2);
});

// --- The repository's refusals ------------------------------------------------

test('a comparison whose totals disagree is refused, and nothing is written', async () => {
  const prisma = makeCognitivePrisma();
  const repo = new ProviderReconciliationRepository(prisma as never);
  const result = await repo.recordDay(ORG, {
    provider: CALLGRID_PROVIDER,
    stream: CALLS_STREAM,
    businessDate: DAY,
    timezone: 'America/New_York',
    windowStart: WINDOW.start,
    windowEnd: WINDOW.end,
    scanStart: WINDOW.start,
    scanEnd: WINDOW.end,
    state: 'RECONCILED',
    ruleVersion: RECONCILIATION_RULE_VERSION,
    localStage: INTEGRATION_EVENT_STAGE,
    counts: {
      providerUnique: 10,
      providerDuplicateIds: 0,
      localUnique: 10,
      localDuplicateIds: 0,
      intersection: 9, // 9 + 0 !== 10
      providerOnly: 0,
      localOnly: 0,
      providerOnlyExpected: 0,
      providerOnlyNotConfigured: 0,
      providerOnlyExcluded: 0,
      providerOnlyUnknownMember: 0,
    },
    evidence: {
      providerRecords: 10, providerUnattributed: 0, localRowsScanned: 10, localInWindow: 10,
      localUnresolvedOccurrence: 0, localMissingIdentity: 0, pagesFetched: 1, pageCap: 100, truncated: false,
    },
    members: [],
    reason: null,
    observedAt: NOW,
    reconciledAt: NOW,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'INCOHERENT_COUNTS');
  // NOTHING was written. An INCONCLUSIVE row here would still assert that a
  // comparison happened, and this one did not.
  assert.equal(prisma.providerReconciliationDay.__rows.length, 0);
});

test('a provider-only split that does not sum is refused', async () => {
  const prisma = makeCognitivePrisma();
  const repo = new ProviderReconciliationRepository(prisma as never);
  const result = await repo.recordDay(ORG, {
    provider: CALLGRID_PROVIDER, stream: CALLS_STREAM, businessDate: DAY,
    timezone: 'America/New_York', windowStart: WINDOW.start, windowEnd: WINDOW.end,
    scanStart: WINDOW.start, scanEnd: WINDOW.end,
    state: 'UNRECONCILED', ruleVersion: RECONCILIATION_RULE_VERSION, localStage: INTEGRATION_EVENT_STAGE,
    counts: {
      providerUnique: 10, providerDuplicateIds: 0, localUnique: 8, localDuplicateIds: 0,
      intersection: 8, providerOnly: 2, localOnly: 0,
      providerOnlyExpected: 1, providerOnlyNotConfigured: 0, providerOnlyExcluded: 0,
      providerOnlyUnknownMember: 0, // 1 !== 2
    },
    evidence: {
      providerRecords: 10, providerUnattributed: 0, localRowsScanned: 8, localInWindow: 8,
      localUnresolvedOccurrence: 0, localMissingIdentity: 0, pagesFetched: 1, pageCap: 100, truncated: false,
    },
    members: [], reason: null, observedAt: NOW, reconciledAt: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'INCOHERENT_COUNTS');
  assert.equal(prisma.providerReconciliationDay.__rows.length, 0);
});

test('a member claiming more absences than the provider held for it is refused', async () => {
  const prisma = makeCognitivePrisma();
  const repo = new ProviderReconciliationRepository(prisma as never);
  const result = await repo.recordDay(ORG, {
    provider: CALLGRID_PROVIDER, stream: CALLS_STREAM, businessDate: DAY,
    timezone: 'America/New_York', windowStart: WINDOW.start, windowEnd: WINDOW.end,
    scanStart: WINDOW.start, scanEnd: WINDOW.end,
    state: 'RECONCILED', ruleVersion: RECONCILIATION_RULE_VERSION, localStage: INTEGRATION_EVENT_STAGE,
    counts: {
      providerUnique: 1, providerDuplicateIds: 0, localUnique: 1, localDuplicateIds: 0,
      intersection: 1, providerOnly: 0, localOnly: 0,
      providerOnlyExpected: 0, providerOnlyNotConfigured: 0, providerOnlyExcluded: 0, providerOnlyUnknownMember: 0,
    },
    evidence: {
      providerRecords: 1, providerUnattributed: 0, localRowsScanned: 1, localInWindow: 1,
      localUnresolvedOccurrence: 0, localMissingIdentity: 0, pagesFetched: 1, pageCap: 100, truncated: false,
    },
    members: [{
      dimension: 'CAMPAIGN', memberExternalId: M_CLEAN,
      providerCount: 1, providerOnly: 5, localCount: 1, localOnly: 0,
      expectationState: 'UNKNOWN', expectationId: null, expectationMatches: 0, labelAtObservation: null,
    }],
    reason: null, observedAt: NOW, reconciledAt: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'INVALID_MEMBER');
  assert.equal(prisma.providerReconciliationDay.__rows.length, 0);
});

test('a resolved expectation that names no declaration is refused', async () => {
  const prisma = makeCognitivePrisma();
  const repo = new ProviderReconciliationRepository(prisma as never);
  const result = await repo.recordDay(ORG, {
    provider: CALLGRID_PROVIDER, stream: CALLS_STREAM, businessDate: DAY,
    timezone: 'America/New_York', windowStart: WINDOW.start, windowEnd: WINDOW.end,
    scanStart: WINDOW.start, scanEnd: WINDOW.end,
    state: 'RECONCILED', ruleVersion: RECONCILIATION_RULE_VERSION, localStage: INTEGRATION_EVENT_STAGE,
    counts: {
      providerUnique: 0, providerDuplicateIds: 0, localUnique: 0, localDuplicateIds: 0,
      intersection: 0, providerOnly: 0, localOnly: 0,
      providerOnlyExpected: 0, providerOnlyNotConfigured: 0, providerOnlyExcluded: 0, providerOnlyUnknownMember: 0,
    },
    evidence: {
      providerRecords: 0, providerUnattributed: 0, localRowsScanned: 0, localInWindow: 0,
      localUnresolvedOccurrence: 0, localMissingIdentity: 0, pagesFetched: 1, pageCap: 100, truncated: false,
    },
    members: [{
      dimension: 'CAMPAIGN', memberExternalId: M_CLEAN,
      providerCount: 0, providerOnly: 0, localCount: 0, localOnly: 0,
      // EXPECTED without naming who said so. The migration's CHECK forbids this
      // in the database; the repository refuses it before it gets there.
      expectationState: 'EXPECTED', expectationId: null, expectationMatches: 1, labelAtObservation: null,
    }],
    reason: null, observedAt: NOW, reconciledAt: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'INVALID_MEMBER');
});

test('the same member computed twice in one comparison is refused, not silently merged', async () => {
  const prisma = makeCognitivePrisma();
  const repo = new ProviderReconciliationRepository(prisma as never);
  const member = {
    dimension: 'CAMPAIGN' as const, memberExternalId: M_CLEAN,
    providerCount: 0, providerOnly: 0, localCount: 0, localOnly: 0,
    expectationState: 'UNKNOWN' as const, expectationId: null, expectationMatches: 0, labelAtObservation: null,
  };
  const result = await repo.recordDay(ORG, {
    provider: CALLGRID_PROVIDER, stream: CALLS_STREAM, businessDate: DAY,
    timezone: 'America/New_York', windowStart: WINDOW.start, windowEnd: WINDOW.end,
    scanStart: WINDOW.start, scanEnd: WINDOW.end,
    state: 'RECONCILED', ruleVersion: RECONCILIATION_RULE_VERSION, localStage: INTEGRATION_EVENT_STAGE,
    counts: {
      providerUnique: 0, providerDuplicateIds: 0, localUnique: 0, localDuplicateIds: 0,
      intersection: 0, providerOnly: 0, localOnly: 0,
      providerOnlyExpected: 0, providerOnlyNotConfigured: 0, providerOnlyExcluded: 0, providerOnlyUnknownMember: 0,
    },
    evidence: {
      providerRecords: 0, providerUnattributed: 0, localRowsScanned: 0, localInWindow: 0,
      localUnresolvedOccurrence: 0, localMissingIdentity: 0, pagesFetched: 1, pageCap: 100, truncated: false,
    },
    members: [member, member], reason: null, observedAt: NOW, reconciledAt: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'INVALID_MEMBER');
});

// --- Attribution helpers -------------------------------------------------------

test('member attribution reads campaignId, and a label is never identity', () => {
  assert.equal(memberIdFrom({ campaignId: 'cmp-1' }), 'cmp-1');
  // The webhook template sends every value as a quoted string; the REST client
  // may return a native one. Both must name the same member.
  assert.equal(memberIdFrom({ campaignId: 123 }), '123');
  assert.equal(memberIdFrom({ campaignId: '  cmp-1  ' }), 'cmp-1');
  assert.equal(memberIdFrom({ campaignId: '' }), null);
  assert.equal(memberIdFrom({ campaign: 'Roofing Texas' }), null);
  assert.equal(memberIdFrom({}), null);
  assert.equal(memberLabelFrom({ campaign: 'Roofing Texas' }), 'Roofing Texas');
  assert.equal(memberLabelFrom({ campaignName: 'Roofing Texas' }), 'Roofing Texas');
  assert.equal(memberLabelFrom({}), null);
});

test('the local side attributes from its OWN payload, so the two can be seen to disagree', async () => {
  const h = harness({
    provider: [providerRecord('a', M_CLEAN), providerRecord('b', M_CLEAN)],
    // Loop received 'b' but recorded it against a different campaign.
    local: [localRecord('a', M_CLEAN), localRecord('b', M_DELIVERING)],
  });
  await declare(h.expectations, ORG, M_CLEAN, 'EXPECTED');
  await declare(h.expectations, ORG, M_DELIVERING, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Both identities matched, so the day reconciles — but the member rows record
  // the disagreement rather than hiding it behind a derived number.
  assert.equal(result.day.state, 'RECONCILED');
  const clean = result.day.members.find((m) => m.memberExternalId === M_CLEAN);
  const other = result.day.members.find((m) => m.memberExternalId === M_DELIVERING);
  assert.equal(clean?.providerCount, 2);
  assert.equal(clean?.localCount, 1);
  assert.equal(other?.providerCount, 0);
  assert.equal(other?.localCount, 1);
});

// --- Stored shape --------------------------------------------------------------

test('the stored fact names its rule version and its local stage', async () => {
  const h = harness({ provider: [], local: [] });
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.day.ruleVersion, RECONCILIATION_RULE_VERSION);
  assert.equal(result.day.localStage, INTEGRATION_EVENT_STAGE);
  assert.equal(result.day.localStage, 'integration_event');
});

test('statesForDates omits a day that was never reconciled — absence certifies nothing', async () => {
  const h = harness({ provider: [], local: [] });
  await run(h);
  const states = await h.reconciliations.statesForDates(
    ORG, CALLGRID_PROVIDER, CALLS_STREAM, [DAY, '2026-08-06'],
  );
  assert.equal(states.get(DAY), 'RECONCILED');
  assert.equal(states.has('2026-08-06'), false);
});

test('an unreadable stored state reads back as null rather than as a guess', async () => {
  const h = harness({ provider: [], local: [] });
  await run(h);
  // Simulates a row written by a future build whose vocabulary widened, or by a
  // direct write. It must never be interpreted as one of the four.
  h.prisma.providerReconciliationDay.__rows[0].state = 'SOMETHING_ELSE';
  const day = await h.reconciliations.findDay(ORG, CALLGRID_PROVIDER, CALLS_STREAM, DAY);
  assert.equal(day?.state, null);
  const states = await h.reconciliations.statesForDates(ORG, CALLGRID_PROVIDER, CALLS_STREAM, [DAY]);
  assert.equal(states.has(DAY), false);
});

// --- The August 5 regression ---------------------------------------------------

test('AUGUST 5: 974 provider identities, 867 local, 107 absent across four campaigns', async () => {
  // Populations are generated to the exact production shape. Member ids are
  // generic; the day's state derives from the DECLARATIONS below and from
  // nothing about which campaign an identifier names.
  const provider: ProviderPopulationRecord[] = [];
  const local: LocalDeliveryRecord[] = [];
  const add = (member: string, total: number, delivered: number, prefix: string) => {
    for (let i = 0; i < total; i += 1) {
      const identity = `${prefix}-${i}`;
      provider.push(providerRecord(identity, member, 'label ignored'));
      if (i < delivered) local.push(localRecord(identity, member));
    }
  };
  add(M_SILENT, 97, 0, 'silent');       // 97 provider-only
  add(M_SPANISH, 6, 0, 'unwired-a');    // 6 provider-only
  add(M_INTERNAL, 3, 0, 'unwired-b');   // 3 provider-only
  add(M_DELIVERING, 622, 621, 'deliv'); // 1 provider-only
  // Five campaigns that reconciled completely, making the totals up to 974/867.
  // 974 - (97 + 6 + 3 + 622) = 246, and 867 - 621 = 246. The same number from
  // both sides, which is the arithmetic this fixture exists to reproduce.
  const clean = [49, 49, 49, 49, 50];
  assert.equal(clean.reduce((a, b) => a + b, 0), 246);
  clean.forEach((n, c) => add(`cmp-clean-${c}`, n, n, `clean${c}`));

  assert.equal(provider.length, 974);
  assert.equal(local.length, 867);

  const h = harness({ provider, local, recordsFetched: 974, pagesFetched: 11 });
  // Only what a person actually verified in the provider's interface on the day:
  // the two campaigns whose webhook was never attached.
  await declare(h.expectations, ORG, M_SPANISH, 'NOT_CONFIGURED');
  await declare(h.expectations, ORG, M_INTERNAL, 'NOT_CONFIGURED');
  await declare(h.expectations, ORG, M_DELIVERING, 'EXPECTED');
  for (let c = 0; c < 5; c += 1) await declare(h.expectations, ORG, `cmp-clean-${c}`, 'EXPECTED');

  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.day.counts.providerUnique, 974);
  assert.equal(result.day.counts.localUnique, 867);
  assert.equal(result.day.counts.intersection, 867);
  assert.equal(result.day.counts.providerOnly, 107);
  assert.equal(result.day.counts.localOnly, 0);

  // The whole point of the split: 107 stops being one alarm.
  assert.equal(result.day.counts.providerOnlyUnknownMember, 97);
  assert.equal(result.day.counts.providerOnlyNotConfigured, 9);
  assert.equal(result.day.counts.providerOnlyExpected, 1);
  assert.equal(result.day.counts.providerOnlyExcluded, 0);

  // The largest population is undeclared, and an unbounded question outranks the
  // one bounded defect underneath it.
  assert.equal(result.day.state, 'UNKNOWN_EXPECTATION');

  const delivering = result.day.members.find((m) => m.memberExternalId === M_DELIVERING);
  assert.equal(delivering?.providerCount, 622);
  assert.equal(delivering?.localCount, 621);
  assert.equal(delivering?.providerOnly, 1);
  assert.equal(delivering?.expectationState, 'EXPECTED');
  assert.equal(result.day.members.length, 9);
});

test('AUGUST 5: declaring the silent campaign turns the same evidence into a bounded defect', async () => {
  const provider: ProviderPopulationRecord[] = [];
  const local: LocalDeliveryRecord[] = [];
  for (let i = 0; i < 97; i += 1) provider.push(providerRecord(`silent-${i}`, M_SILENT));
  for (let i = 0; i < 622; i += 1) {
    provider.push(providerRecord(`deliv-${i}`, M_DELIVERING));
    if (i < 621) local.push(localRecord(`deliv-${i}`, M_DELIVERING));
  }
  const h = harness({ provider, local });
  await declare(h.expectations, ORG, M_SILENT, 'NOT_CONFIGURED');
  await declare(h.expectations, ORG, M_DELIVERING, 'EXPECTED');
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // 97 correct absences and exactly one real defect. The number that matters is
  // no longer buried in the total.
  assert.equal(result.day.state, 'UNRECONCILED');
  assert.equal(result.day.counts.providerOnlyNotConfigured, 97);
  assert.equal(result.day.counts.providerOnlyExpected, 1);
});

// --- Expectation provenance ----------------------------------------------------
//
// THE PROPERTY: a member row's classification must always be traceable to the
// exact declaration that produced it, and must never point at one it did not use.
//
// This is what the whole persistence choice rests on. PR 3 stores ONE current
// answer per day rather than an append-only history, and the reason that is safe
// is that the member row names its declaration and PR 2 never rewrites a
// declaration. A row saying NOT_CONFIGURED with nothing behind it would record a
// classification nobody can later justify -- exactly the situation the
// expectation table was built to end.

test('every declarable state names its declaration; UNKNOWN names none', async () => {
  const h = harness({
    provider: [
      providerRecord('a', M_DELIVERING),
      providerRecord('b', M_SPANISH),
      providerRecord('c', M_INTERNAL),
      providerRecord('d', M_SILENT),
    ],
    local: [],
  });
  const expected = await declare(h.expectations, ORG, M_DELIVERING, 'EXPECTED');
  const notConfigured = await declare(h.expectations, ORG, M_SPANISH, 'NOT_CONFIGURED');
  const excluded = await declare(h.expectations, ORG, M_INTERNAL, 'EXCLUDED');
  // M_SILENT is deliberately never declared.

  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const by = (id: string) => result.day.members.find((m) => m.memberExternalId === id);
  assert.equal(by(M_DELIVERING)?.expectationState, 'EXPECTED');
  assert.equal(by(M_DELIVERING)?.expectationId, expected);
  assert.equal(by(M_SPANISH)?.expectationState, 'NOT_CONFIGURED');
  assert.equal(by(M_SPANISH)?.expectationId, notConfigured);
  assert.equal(by(M_INTERNAL)?.expectationState, 'EXCLUDED');
  assert.equal(by(M_INTERNAL)?.expectationId, excluded);
  assert.equal(by(M_SILENT)?.expectationState, 'UNKNOWN');
  assert.equal(by(M_SILENT)?.expectationId, null);

  // Stated as the invariant rather than as four assertions, so a fifth state
  // added later is covered on the day it is added.
  for (const member of result.day.members) {
    assert.equal(
      member.expectationId === null,
      member.expectationState === 'UNKNOWN',
      `${member.memberExternalId} must name a declaration exactly when its state is not UNKNOWN`,
    );
  }
});

test('the named declaration is the one in force ON THE DATE, not the newest one', async () => {
  const h = harness({
    provider: [providerRecord('a', M_SPANISH)],
    local: [],
  });
  const onTheDay = await declare(h.expectations, ORG, M_SPANISH, 'NOT_CONFIGURED', { effectiveTo: '2026-08-19' });
  const later = await declare(h.expectations, ORG, M_SPANISH, 'EXPECTED', { effectiveFrom: '2026-08-19' });
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const member = result.day.members.find((m) => m.memberExternalId === M_SPANISH);
  assert.equal(member?.expectationId, onTheDay);
  assert.notEqual(member?.expectationId, later);
});

test('two overlapping declarations resolve UNKNOWN and name NEITHER of them', async () => {
  // The resolver refuses to choose between two statements about one date, and
  // the member row must not quietly pick one -- naming a declaration the
  // comparison did not rely on is a false provenance trail.
  const h = harness({ provider: [providerRecord('a', M_SPANISH)], local: [] });
  await declare(h.expectations, ORG, M_SPANISH, 'NOT_CONFIGURED');
  // Written around the repository, exactly as a direct database write would be.
  h.prisma.providerMemberExpectation.__rows.push({
    id: 'rogue',
    organizationId: ORG,
    provider: CALLGRID_PROVIDER,
    stream: CALLS_STREAM,
    memberDimension: 'CAMPAIGN',
    memberExternalId: M_SPANISH,
    state: 'EXPECTED',
    exclusionReason: null,
    basis: 'OPERATOR_DECLARED',
    reason: 'conflicting',
    effectiveFrom: businessDateToColumn('2026-01-01'),
    effectiveTo: null,
    declaredByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const result = await run(h);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const member = result.day.members.find((m) => m.memberExternalId === M_SPANISH);
  assert.equal(member?.expectationState, 'UNKNOWN');
  assert.equal(member?.expectationId, null);
  assert.equal(member?.expectationMatches, 2);
});

test('UNKNOWN naming a declaration is refused — it would point at one it did not use', async () => {
  const prisma = makeCognitivePrisma();
  const repo = new ProviderReconciliationRepository(prisma as never);
  const result = await repo.recordDay(ORG, emptyDayInput({
    members: [{
      dimension: 'CAMPAIGN', memberExternalId: M_CLEAN,
      providerCount: 0, providerOnly: 0, localCount: 0, localOnly: 0,
      expectationState: 'UNKNOWN', expectationId: 'decl-1', expectationMatches: 0,
      labelAtObservation: null,
    }],
  }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'INVALID_MEMBER');
    assert.match(result.problems.join(' '), /UNKNOWN cannot name a declaration/);
  }
  assert.equal(prisma.providerReconciliationDay.__rows.length, 0);
});

test('each declarable state without a declaration is refused', async () => {
  for (const state of ['EXPECTED', 'NOT_CONFIGURED', 'EXCLUDED'] as const) {
    const prisma = makeCognitivePrisma();
    const repo = new ProviderReconciliationRepository(prisma as never);
    const result = await repo.recordDay(ORG, emptyDayInput({
      members: [{
        dimension: 'CAMPAIGN', memberExternalId: M_CLEAN,
        providerCount: 0, providerOnly: 0, localCount: 0, localOnly: 0,
        expectationState: state, expectationId: null, expectationMatches: 1,
        labelAtObservation: null,
      }],
    }));
    assert.equal(result.ok, false, `${state} with no declaration must be refused`);
    if (!result.ok) assert.equal(result.reason, 'INVALID_MEMBER');
    assert.equal(prisma.providerReconciliationDay.__rows.length, 0);
  }
});

// --- Cross-member ownership ----------------------------------------------------
//
// The foreign key proves a declaration EXISTS. It does not prove it is about this
// member, and Postgres would accept a row for campaign A naming a declaration
// about campaign B. The write layer is where that is refused.

async function ownershipHarness(): Promise<{
  prisma: ReturnType<typeof makeCognitivePrisma>;
  repo: ProviderReconciliationRepository;
  mine: string;
  foreign: string;
  otherMember: string;
  otherStream: string;
}> {
  const prisma = makeCognitivePrisma();
  const repo = new ProviderReconciliationRepository(prisma as never);
  const expectations = new ProviderMemberExpectationRepository(prisma as never);
  const mine = await declare(expectations, ORG, M_CLEAN, 'NOT_CONFIGURED');
  const otherMember = await declare(expectations, ORG, M_SILENT, 'EXCLUDED');
  const foreign = await declare(expectations, OTHER_ORG, M_CLEAN, 'EXPECTED');
  const other = await expectations.declare(ORG, {
    provider: CALLGRID_PROVIDER, stream: 'leads', dimension: 'CAMPAIGN',
    memberExternalId: M_CLEAN, state: 'EXPECTED', exclusionReason: null,
    basis: 'OPERATOR_DECLARED', reason: 'a different stream', effectiveFrom: '2026-01-01',
  });
  assert.equal(other.ok, true);
  return {
    prisma, repo, mine, foreign, otherMember,
    otherStream: other.ok ? other.declaration.id : '',
  };
}

function ownershipMember(memberExternalId: string, expectationId: string) {
  return {
    dimension: 'CAMPAIGN' as const,
    memberExternalId,
    providerCount: 0, providerOnly: 0, localCount: 0, localOnly: 0,
    expectationState: 'NOT_CONFIGURED' as const,
    expectationId,
    expectationMatches: 1,
    labelAtObservation: null,
  };
}

test("a declaration about this member IS accepted", async () => {
  const o = await ownershipHarness();
  const result = await o.repo.recordDay(ORG, emptyDayInput({
    members: [ownershipMember(M_CLEAN, o.mine)],
  }));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.day.members[0]?.expectationId, o.mine);
});

test("a declaration about a DIFFERENT MEMBER is refused", async () => {
  const o = await ownershipHarness();
  const result = await o.repo.recordDay(ORG, emptyDayInput({
    members: [ownershipMember(M_CLEAN, o.otherMember)],
  }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'EXPECTATION_NOT_OWNED');
    assert.match(result.problems.join(' '), /different member, stream or provider/);
  }
  assert.equal(o.prisma.providerReconciliationDay.__rows.length, 0);
});

test("a declaration belonging to ANOTHER ORGANIZATION is refused, and reads as absent", async () => {
  const o = await ownershipHarness();
  const result = await o.repo.recordDay(ORG, emptyDayInput({
    members: [ownershipMember(M_CLEAN, o.foreign)],
  }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'EXPECTATION_NOT_OWNED');
    // NOT-FOUND, never forbidden: the scoped resolve simply does not see it, so
    // the message cannot leak that another tenant holds that id.
    assert.match(result.problems.join(' '), /this organization does not have/);
  }
  assert.equal(o.prisma.providerReconciliationDay.__rows.length, 0);
});

test("a declaration about the same member on a DIFFERENT STREAM is refused", async () => {
  const o = await ownershipHarness();
  const result = await o.repo.recordDay(ORG, emptyDayInput({
    members: [ownershipMember(M_CLEAN, o.otherStream)],
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'EXPECTATION_NOT_OWNED');
});

test("a declaration id that does not exist at all is refused before the foreign key sees it", async () => {
  const o = await ownershipHarness();
  const result = await o.repo.recordDay(ORG, emptyDayInput({
    members: [ownershipMember(M_CLEAN, 'decl-does-not-exist')],
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'EXPECTATION_NOT_OWNED');
});

test('the ownership check costs one scoped read no matter how many members name declarations', async () => {
  const o = await ownershipHarness();
  let reads = 0;
  const findMany = o.prisma.providerMemberExpectation.findMany.bind(o.prisma.providerMemberExpectation);
  o.prisma.providerMemberExpectation.findMany = async (args: unknown) => {
    reads += 1;
    return findMany(args);
  };
  await o.repo.recordDay(ORG, emptyDayInput({
    members: [
      ownershipMember(M_CLEAN, o.mine),
      { ...ownershipMember(M_SILENT, o.otherMember), expectationState: 'EXCLUDED' as const },
    ],
  }));
  assert.equal(reads, 1);
});

test('a run that names no declaration at all does not read the expectation table', async () => {
  const o = await ownershipHarness();
  let reads = 0;
  const findMany = o.prisma.providerMemberExpectation.findMany.bind(o.prisma.providerMemberExpectation);
  o.prisma.providerMemberExpectation.findMany = async (args: unknown) => {
    reads += 1;
    return findMany(args);
  };
  const result = await o.repo.recordDay(ORG, emptyDayInput({ members: [] }));
  assert.equal(result.ok, true);
  assert.equal(reads, 0);
});
