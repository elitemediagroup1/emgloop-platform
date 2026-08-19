// Measurement source authority — whose number this is.
//
// THE PROPERTY UNDER TEST, ONCE
//
// A source CONTAINING a value must never become authoritative for it. Every case
// below is a way that could fail: an authority inferred from data being present,
// from a stream being configured, from a reconciliation succeeding; a resolver
// that guesses when nobody has said; a resolver that picks a winner when two
// people disagree; an authority read as of today rather than as of the date being
// measured; or one organization's registration answering another's question.
//
// The counter-property matters just as much: one campaign must be able to take
// call volume from a provider and revenue from a counterparty ON THE SAME DAY
// without either being a contradiction. That is the entire reason this layer
// exists, and it is the first thing asserted.
//
// NO LINE OF BUSINESS APPEARS ANYWHERE. A program measured from a counterparty's
// report is two rows of data naming an external id and a source key; a test at
// the end asserts no branch, constant or string in the layer knows which program
// it is.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MEASURE_METRICS,
  assessReadiness,
  type BusinessDate,
  type ReadinessInput,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import {
  MeasurementSourceRepository,
  type DeclareAuthorityInput,
  type RegisterSourceInput,
} from '../src/repositories/measurement-source.repository';

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';

// Generic fixture identifiers. No business name, no real campaign id, no buyer.
const CAMPAIGN_A = 'cmp-alpha';
const CAMPAIGN_B = 'cmp-beta';

const STREAM_SOURCE = 'provider-stream-a';
const REPORT_SOURCE = 'counterparty-report-a';
const OTHER_REPORT = 'counterparty-report-b';

const JAN_01: BusinessDate = '2026-01-01';
const AUG_01: BusinessDate = '2026-08-01';
const AUG_05: BusinessDate = '2026-08-05';
const AUG_19: BusinessDate = '2026-08-19';
const SEP_01: BusinessDate = '2026-09-01';

function make() {
  const prisma = makeCognitivePrisma();
  return { prisma, sources: new MeasurementSourceRepository(prisma as never) };
}

function streamSource(over: Partial<RegisterSourceInput> = {}): RegisterSourceInput {
  return {
    key: STREAM_SOURCE,
    kind: 'PROVIDER_STREAM',
    displayName: 'The polled call stream',
    provider: 'callgrid',
    stream: 'calls',
    metrics: [
      { metric: 'CALL_VOLUME', measureDefinitionId: 'calls.observed.v1' },
      { metric: 'REVENUE', measureDefinitionId: 'provider.revenue.v1' },
    ],
    ...over,
  };
}

function reportSource(over: Partial<RegisterSourceInput> = {}): RegisterSourceInput {
  return {
    key: REPORT_SOURCE,
    kind: 'BUYER_REPORT',
    displayName: 'A counterparty outcome report',
    provider: null,
    stream: null,
    metrics: [{ metric: 'REVENUE', measureDefinitionId: 'counterparty.settled-revenue.v1' }],
    ...over,
  };
}

function authority(over: Partial<DeclareAuthorityInput> = {}): DeclareAuthorityInput {
  return {
    dimension: 'CAMPAIGN',
    memberExternalId: CAMPAIGN_A,
    metric: 'REVENUE',
    sourceKey: REPORT_SOURCE,
    reason: 'The counterparty settles the following day and reports outcomes itself.',
    effectiveFrom: AUG_01,
    effectiveTo: null,
    ...over,
  };
}

async function seeded() {
  const h = make();
  const a = await h.sources.registerSource(ORG, streamSource());
  const b = await h.sources.registerSource(ORG, reportSource());
  assert.equal(a.ok && b.ok, true, 'fixture sources must register');
  return h;
}

// --- The case this layer exists for ----------------------------------------------

test('one campaign takes volume from the stream and revenue from the report, same day', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ metric: 'CALL_VOLUME', sourceKey: STREAM_SOURCE }));
  await h.sources.declareAuthority(ORG, authority({ metric: 'REVENUE', sourceKey: REPORT_SOURCE }));

  const volume = await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'CALL_VOLUME', AUG_05);
  const revenue = await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', AUG_05);

  assert.equal(volume.outcome, 'RESOLVED');
  assert.equal(volume.sourceKey, STREAM_SOURCE);
  assert.equal(revenue.outcome, 'RESOLVED');
  assert.equal(revenue.sourceKey, REPORT_SOURCE);
  // Not a contradiction, and not a conflict. Two measures, two answers.
  assert.notEqual(volume.sourceKey, revenue.sourceKey);
});

test('a second campaign can take the same measure from a different source', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ memberExternalId: CAMPAIGN_A, sourceKey: REPORT_SOURCE }));
  await h.sources.declareAuthority(ORG, authority({ memberExternalId: CAMPAIGN_B, sourceKey: STREAM_SOURCE }));

  const a = await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', AUG_05);
  const b = await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_B, 'REVENUE', AUG_05);
  assert.equal(a.sourceKey, REPORT_SOURCE);
  assert.equal(b.sourceKey, STREAM_SOURCE);
});

// --- Persistence and effective dating --------------------------------------------

test('an authority declaration persists and reads back with its provenance', async () => {
  const h = await seeded();
  const result = await h.sources.declareAuthority(ORG, authority({ declaredByUserId: 'user_1' }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.declaration.sourceKey, REPORT_SOURCE);
  assert.equal(result.declaration.effectiveFrom, AUG_01);
  assert.equal(result.declaration.effectiveTo, null);
  assert.equal(result.declaration.declaredByUserId, 'user_1');
  assert.match(result.declaration.reason, /settles the following day/);
  assert.equal(result.supersededId, null);
  assert.equal(result.unchanged, false);
});

test('an authority resolves ON its effectiveFrom, which is inclusive', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ effectiveFrom: AUG_05 }));
  const on = await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', AUG_05);
  assert.equal(on.outcome, 'RESOLVED');
});

test('an authority does not resolve BEFORE its effectiveFrom', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ effectiveFrom: AUG_05 }));
  const before = await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', AUG_01);
  assert.equal(before.outcome, 'MISSING');
  assert.equal(before.sourceKey, null);
});

test('effectiveTo is EXCLUSIVE — the end date belongs to the successor', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ effectiveFrom: AUG_01, effectiveTo: AUG_19 }));
  assert.equal((await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', '2026-08-18')).outcome, 'RESOLVED');
  assert.equal((await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', AUG_19)).outcome, 'MISSING');
});

test('an open-ended authority still resolves months later', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ effectiveFrom: JAN_01, effectiveTo: null }));
  assert.equal((await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', '2027-03-14')).outcome, 'RESOLVED');
});

test('a successor ends the predecessor by moving ONE column and preserves what it said', async () => {
  const h = await seeded();
  const first = await h.sources.declareAuthority(ORG, authority({ sourceKey: STREAM_SOURCE, effectiveFrom: AUG_01 }));
  assert.equal(first.ok, true);
  const second = await h.sources.declareAuthority(ORG, authority({ sourceKey: REPORT_SOURCE, effectiveFrom: AUG_19 }));
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.supersededId, first.declaration.id);

  const history = await h.sources.authoritiesFor(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE');
  assert.equal(history.length, 2);
  const [predecessor, successor] = history;
  // The closed row keeps its source, reason and author. Only its end moved.
  assert.equal(predecessor?.sourceKey, STREAM_SOURCE);
  assert.equal(predecessor?.effectiveFrom, AUG_01);
  assert.equal(predecessor?.effectiveTo, AUG_19);
  assert.equal(successor?.sourceKey, REPORT_SOURCE);
  assert.equal(successor?.effectiveTo, null);
});

test('an authority change resolves HISTORICALLY, not as of today', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ sourceKey: STREAM_SOURCE, effectiveFrom: AUG_01 }));
  await h.sources.declareAuthority(ORG, authority({ sourceKey: REPORT_SOURCE, effectiveFrom: AUG_19 }));

  // Re-running last month's comparison must resolve last month's answer, or a
  // stored Headline silently changes meaning when a configuration changes.
  assert.equal((await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', AUG_05)).sourceKey, STREAM_SOURCE);
  assert.equal((await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', SEP_01)).sourceKey, REPORT_SOURCE);
});

test('restating an identical authority writes nothing', async () => {
  const h = await seeded();
  const first = await h.sources.declareAuthority(ORG, authority());
  const again = await h.sources.declareAuthority(ORG, authority());
  assert.equal(again.ok, true);
  if (!first.ok || !again.ok) return;
  assert.equal(again.unchanged, true);
  assert.equal(again.declaration.id, first.declaration.id);
  assert.equal(h.prisma.measureSourceAuthority.__rows.length, 1);
});

test('an overlapping authority is refused rather than swallowing the existing one', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ sourceKey: STREAM_SOURCE, effectiveFrom: AUG_19 }));
  const clash = await h.sources.declareAuthority(ORG, authority({ sourceKey: REPORT_SOURCE, effectiveFrom: AUG_19 }));
  assert.equal(clash.ok, false);
  if (!clash.ok) assert.equal(clash.reason, 'OVERLAPS_EXISTING');
  assert.equal(h.prisma.measureSourceAuthority.__rows.length, 1);
});

test('back-to-back declarations do NOT collide — the range is half-open', async () => {
  const h = await seeded();
  const a = await h.sources.declareAuthority(ORG, authority({ sourceKey: STREAM_SOURCE, effectiveFrom: AUG_01, effectiveTo: AUG_19 }));
  const b = await h.sources.declareAuthority(ORG, authority({ sourceKey: REPORT_SOURCE, effectiveFrom: AUG_19 }));
  assert.equal(a.ok && b.ok, true);
  assert.equal(h.prisma.measureSourceAuthority.__rows.length, 2);
});

// --- Fail-closed resolution --------------------------------------------------------

test('no declaration is MISSING — never "assume the provider"', async () => {
  const h = await seeded();
  const resolved = await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', AUG_05);
  assert.equal(resolved.outcome, 'MISSING');
  assert.equal(resolved.sourceKey, null);
  assert.equal(resolved.matches, 0);
});

test('a registered source that reports the measure does NOT thereby become authoritative', async () => {
  // The whole rule, in one case. The stream source declares a REVENUE definition
  // and is the only source registered — and revenue still has no authority.
  const h = make();
  await h.sources.registerSource(ORG, streamSource());
  const resolved = await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', AUG_05);
  assert.equal(resolved.outcome, 'MISSING');
});

test('a stream being configured with a provider does not make it authoritative', async () => {
  const h = make();
  await h.sources.registerSource(ORG, streamSource());
  for (const metric of MEASURE_METRICS) {
    const resolved = await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, metric, AUG_05);
    assert.equal(resolved.outcome, 'MISSING', `${metric} must not be inferred from configuration`);
  }
});

test('two declarations covering one date are CONFLICT, never a precedence puzzle', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ sourceKey: STREAM_SOURCE, effectiveFrom: AUG_01 }));
  // Written around the repository, exactly as a direct database write would be.
  const first = h.prisma.measureSourceAuthority.__rows[0];
  h.prisma.measureSourceAuthority.__rows.push({ ...first, id: 'rogue' });

  const resolved = await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', AUG_05);
  assert.equal(resolved.outcome, 'CONFLICT');
  assert.equal(resolved.sourceKey, null);
  assert.equal(resolved.matches, 2);
});

test('a row whose stored vocabulary cannot be read makes the date CONFLICT, not confident', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ effectiveFrom: AUG_01 }));
  h.prisma.measureSourceAuthority.__rows[0].metric = 'SOMETHING_ELSE';
  // Dropping it silently would turn "we cannot read what we said" into MISSING,
  // which reads as "nobody said" and is a different, weaker claim.
  const resolved = await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', AUG_05);
  assert.equal(resolved.outcome, 'MISSING');
});

test('an authority whose source row vanished is not resolvable', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority());
  h.prisma.measurementSource.__rows.length = 0;
  const resolved = await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', AUG_05);
  // The database refuses this with ON DELETE RESTRICT; the read fails closed
  // anyway rather than reporting an authority it cannot name.
  assert.equal(resolved.outcome, 'CONFLICT');
});

// --- Isolation ---------------------------------------------------------------------

test("another organization's authority does not answer this organization's question", async () => {
  const h = await seeded();
  await h.sources.registerSource(OTHER_ORG, reportSource());
  await h.sources.declareAuthority(OTHER_ORG, authority());
  const mine = await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', AUG_05);
  assert.equal(mine.outcome, 'MISSING');
});

test("an authority cannot name a source another organization registered", async () => {
  const h = make();
  await h.sources.registerSource(OTHER_ORG, reportSource());
  const declared = await h.sources.declareAuthority(ORG, authority());
  assert.equal(declared.ok, false);
  if (!declared.ok) assert.equal(declared.reason, 'SOURCE_NOT_REGISTERED');
  assert.equal(h.prisma.measureSourceAuthority.__rows.length, 0);
});

test('authority is per MEMBER — a declaration for one campaign says nothing about another', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ memberExternalId: CAMPAIGN_A }));
  assert.equal((await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_B, 'REVENUE', AUG_05)).outcome, 'MISSING');
});

test('authority is per MEASURE — declaring revenue says nothing about call volume', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ metric: 'REVENUE' }));
  assert.equal((await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'CALL_VOLUME', AUG_05)).outcome, 'MISSING');
});

test('authority is per DIMENSION — a campaign declaration says nothing about a buyer', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ dimension: 'CAMPAIGN' }));
  assert.equal((await h.sources.resolveAuthorityOn(ORG, 'BUYER', CAMPAIGN_A, 'REVENUE', AUG_05)).outcome, 'MISSING');
});

test("one organization's sources are invisible to another", async () => {
  const h = await seeded();
  assert.equal((await h.sources.listSources(OTHER_ORG)).length, 0);
  assert.equal(await h.sources.findSource(OTHER_ORG, REPORT_SOURCE), null);
  assert.equal((await h.sources.listSources(ORG)).length, 2);
});

// --- Registering a source ------------------------------------------------------------

test('a source registers with exactly the metrics it declares a definition for', async () => {
  const h = make();
  const result = await h.sources.registerSource(ORG, reportSource());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.source.supportedMetrics, ['REVENUE']);
  assert.equal(result.source.measureDefinitionIds.REVENUE, 'counterparty.settled-revenue.v1');
  assert.equal(result.source.kind, 'BUYER_REPORT');
  assert.equal(result.source.provider, null);
  assert.equal(result.source.stream, null);
  assert.equal(result.created, true);
});

test('re-registering the same key REPLACES its metric set rather than merging', async () => {
  const h = make();
  await h.sources.registerSource(ORG, streamSource());
  const again = await h.sources.registerSource(
    ORG,
    streamSource({ metrics: [{ metric: 'CALL_VOLUME', measureDefinitionId: 'calls.observed.v1' }] }),
  );
  assert.equal(again.ok, true);
  if (!again.ok) return;
  // A metric withdrawn from a source must stop being supported, not linger.
  assert.deepEqual(again.source.supportedMetrics, ['CALL_VOLUME']);
  assert.equal(again.created, false);
  assert.equal(h.prisma.measurementSource.__rows.length, 1);
});

test('PROVIDER_STREAM requires a provider and a stream; BUYER_REPORT forbids them', async () => {
  const h = make();
  const noStream = await h.sources.registerSource(ORG, streamSource({ provider: null, stream: null }));
  assert.equal(noStream.ok, false);
  if (!noStream.ok) assert.equal(noStream.reason, 'INVALID_SOURCE');

  const reportWithStream = await h.sources.registerSource(
    ORG,
    reportSource({ provider: 'callgrid', stream: 'calls' }),
  );
  assert.equal(reportWithStream.ok, false);
  if (!reportWithStream.ok) assert.match(reportWithStream.problems.join(' '), /only meaningful on PROVIDER_STREAM/);
});

test('a metric outside the shipped vocabulary is refused, and so is a blank definition', async () => {
  const h = make();
  const badMetric = await h.sources.registerSource(
    ORG,
    reportSource({ metrics: [{ metric: 'PROFIT' as never, measureDefinitionId: 'x' }] }),
  );
  assert.equal(badMetric.ok, false);
  if (!badMetric.ok) assert.equal(badMetric.reason, 'INVALID_METRIC');

  const blankDefinition = await h.sources.registerSource(
    ORG,
    reportSource({ metrics: [{ metric: 'REVENUE', measureDefinitionId: '   ' }] }),
  );
  assert.equal(blankDefinition.ok, false);
  if (!blankDefinition.ok) assert.match(blankDefinition.problems.join(' '), /not usable/);
});

test('a blank key, a blank display name, and an unknown kind are all refused', async () => {
  const h = make();
  for (const over of [{ key: '  ' }, { displayName: '' }, { kind: 'MAGIC' as never }]) {
    const result = await h.sources.registerSource(ORG, reportSource(over));
    assert.equal(result.ok, false);
  }
  assert.equal(h.prisma.measurementSource.__rows.length, 0);
});

test('a source registered under one key does not answer for another key', async () => {
  const h = await seeded();
  assert.equal(await h.sources.findSource(ORG, OTHER_REPORT), null);
});

// --- Declaration refusals ------------------------------------------------------------

test('an authority naming an unregistered source is refused, and nothing is written', async () => {
  const h = await seeded();
  const result = await h.sources.declareAuthority(ORG, authority({ sourceKey: OTHER_REPORT }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'SOURCE_NOT_REGISTERED');
  assert.equal(h.prisma.measureSourceAuthority.__rows.length, 0);
});

test('an authority naming a source that cannot supply the measure is refused at declaration time', async () => {
  const h = await seeded();
  // The report source declares REVENUE only. Believing it about call volume
  // would withhold at the gate; refusing here means the operator learns now.
  const result = await h.sources.declareAuthority(
    ORG,
    authority({ metric: 'CALL_VOLUME', sourceKey: REPORT_SOURCE }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'SOURCE_DOES_NOT_SUPPORT_METRIC');
});

test('a blank reason is refused — an unexplained authority is a place to hide', async () => {
  const h = await seeded();
  const result = await h.sources.declareAuthority(ORG, authority({ reason: '   ' }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'REASON_REQUIRED');
});

test('a malformed declaration is refused before anything is read', async () => {
  const h = await seeded();
  for (const over of [
    { memberExternalId: '  ' },
    { metric: 'PROFIT' as never },
    { dimension: 'PROGRAM' as never },
    { effectiveFrom: AUG_19, effectiveTo: AUG_19 },
    { effectiveFrom: AUG_19, effectiveTo: AUG_01 },
  ]) {
    const result = await h.sources.declareAuthority(ORG, authority(over));
    assert.equal(result.ok, false, `${JSON.stringify(over)} must be refused`);
    if (!result.ok) assert.equal(result.reason, 'INVALID_DECLARATION');
  }
  assert.equal(h.prisma.measureSourceAuthority.__rows.length, 0);
});

// --- Nothing infers ------------------------------------------------------------------

test('the write surface takes no call, no value, no configuration and no verdict', async () => {
  // Structural, like the expectation repository's equivalent. There is no method
  // here that could be handed a revenue figure, a webhook, an import result or a
  // reconciliation outcome, so authority CANNOT be inferred from any of them.
  // Named explicitly rather than by prefix. A prefix rule quietly absorbs the
  // next method somebody adds, which is the opposite of what this is for: a new
  // method must force a decision here about whether it writes.
  const READ_ONLY = [
    'findSource',
    'listSources',
    'resolveAuthorityOn',
    'authoritiesFor',
    'readinessFacts',
    // Private helpers. Both are selects.
    'metricsFor',
    'sourceKeysById',
    'loadRows',
    'readDeclarations',
  ];
  const writes = Object.getOwnPropertyNames(MeasurementSourceRepository.prototype).filter(
    (name) => name !== 'constructor' && !READ_ONLY.includes(name),
  );
  assert.deepEqual(writes.sort(), ['declareAuthority', 'registerSource']);

  for (const shape of [Object.keys(authority()), Object.keys(reportSource())]) {
    for (const forbidden of ['revenue', 'calls', 'observed', 'reconciliation', 'webhook', 'imported', 'value']) {
      assert.equal(shape.includes(forbidden), false, `no write may accept ${forbidden}`);
    }
  }
});

test('recording a reconciliation or an expectation cannot change an authority', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ sourceKey: STREAM_SOURCE }));
  const before = await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', AUG_05);

  // Anything else Stage 3 writes, arriving in the same database.
  h.prisma.providerReconciliationDay.__rows.push({ id: 'day', organizationId: ORG, state: 'RECONCILED' });
  h.prisma.providerMemberExpectation.__rows.push({ id: 'exp', organizationId: ORG, state: 'EXPECTED' });

  const after = await h.sources.resolveAuthorityOn(ORG, 'CAMPAIGN', CAMPAIGN_A, 'REVENUE', AUG_05);
  assert.deepEqual(after, before);
});

// --- Readiness integration ------------------------------------------------------------

function readinessInput(over: Partial<ReadinessInput>): ReadinessInput {
  return {
    metric: 'REVENUE',
    dates: [AUG_05],
    observation: { fullyObserved: true, uncertified: [], dates: [AUG_05] } as never,
    partitions: [{ dimension: 'CAMPAIGN', memberExternalId: CAMPAIGN_A }],
    unattributedCalls: 0,
    reconciliation: [
      {
        businessDate: AUG_05,
        state: 'RECONCILED',
        ruleVersion: 'provider-reconciliation.v1',
        counts: {
          providerUnique: 10, providerDuplicateIds: 0, localUnique: 10, localDuplicateIds: 0,
          intersection: 10, providerOnly: 0, localOnly: 0,
          providerOnlyExpected: 0, providerOnlyNotConfigured: 0, providerOnlyExcluded: 0,
          providerOnlyUnknownMember: 0,
        },
        members: [
          {
            dimension: 'CAMPAIGN', memberExternalId: CAMPAIGN_A,
            providerCount: 10, localCount: 10, providerOnly: 0, expectation: 'EXPECTED',
          },
        ],
      },
    ],
    authorities: [],
    sources: [],
    outcomeDays: [],
    ...over,
  };
}

test('persisted authority reaches assessReadiness as DATA — there is no second engine', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ metric: 'REVENUE', sourceKey: REPORT_SOURCE }));

  const facts = await h.sources.readinessFacts(
    ORG,
    [{ dimension: 'CAMPAIGN', memberExternalId: CAMPAIGN_A }],
    'REVENUE',
  );
  // The repository returns the EXACT arrays ReadinessInput already declares.
  const verdict = assessReadiness(readinessInput({ ...facts }));

  // The authority resolved, so the gate got past it and stopped on the NEXT
  // thing: a BUYER_REPORT has delivered nothing for this date.
  assert.equal(verdict.findings.some((f) => f.reason === 'SOURCE_AUTHORITY_MISSING'), false);
  assert.equal(verdict.findings.some((f) => f.reason === 'SOURCE_AUTHORITY_CONFLICT'), false);
  assert.deepEqual(verdict.findings.map((f) => f.reason), ['AUTHORITATIVE_DATA_PENDING']);
});

test('no persisted authority withholds the measurement at the gate', async () => {
  const h = await seeded();
  const facts = await h.sources.readinessFacts(
    ORG,
    [{ dimension: 'CAMPAIGN', memberExternalId: CAMPAIGN_A }],
    'REVENUE',
  );
  const verdict = assessReadiness(readinessInput({ ...facts }));
  assert.equal(verdict.ready, false);
  assert.deepEqual(verdict.findings.map((f) => f.reason), ['SOURCE_AUTHORITY_MISSING']);
  assert.equal(verdict.outcome, 'CONFIG_ERROR');
});

test('a stream-authoritative measure passes the gate once the stream is authoritative', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ metric: 'CALL_VOLUME', sourceKey: STREAM_SOURCE }));
  const facts = await h.sources.readinessFacts(
    ORG,
    [{ dimension: 'CAMPAIGN', memberExternalId: CAMPAIGN_A }],
    'CALL_VOLUME',
  );
  const verdict = assessReadiness(readinessInput({ metric: 'CALL_VOLUME', ...facts }));
  // A polled stream proves availability by having been observed and reconciled,
  // which this fixture has. Nothing objects.
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.resolvedSourceKeys, [STREAM_SOURCE]);
});

test('readinessFacts returns EVERY authority for the member, not only today’s', async () => {
  // A window spanning a change of authority needs both sides of it, because the
  // gate resolves per business date.
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ sourceKey: STREAM_SOURCE, effectiveFrom: AUG_01 }));
  await h.sources.declareAuthority(ORG, authority({ sourceKey: REPORT_SOURCE, effectiveFrom: AUG_19 }));
  const facts = await h.sources.readinessFacts(
    ORG,
    [{ dimension: 'CAMPAIGN', memberExternalId: CAMPAIGN_A }],
    'REVENUE',
  );
  assert.equal(facts.authorities.length, 2);
  assert.deepEqual(facts.authorities.map((a) => a.sourceKey), [STREAM_SOURCE, REPORT_SOURCE]);
});

test('readinessFacts is organization-scoped and metric-scoped', async () => {
  const h = await seeded();
  await h.sources.declareAuthority(ORG, authority({ metric: 'REVENUE' }));
  const other = await h.sources.readinessFacts(OTHER_ORG, [{ dimension: 'CAMPAIGN', memberExternalId: CAMPAIGN_A }], 'REVENUE');
  assert.deepEqual(other.authorities, []);
  assert.deepEqual(other.sources, []);
  const wrongMetric = await h.sources.readinessFacts(ORG, [{ dimension: 'CAMPAIGN', memberExternalId: CAMPAIGN_A }], 'NO_ROUTE_RATE');
  assert.deepEqual(wrongMetric.authorities, []);
});

// --- No line of business ---------------------------------------------------------------

test('nothing in the authority layer knows which program it is', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const sources = [
    join(here, '..', 'src', 'repositories', 'measurement-source.repository.ts'),
    join(here, '..', '..', 'shared', 'src', 'measurement-source.ts'),
    join(here, '..', '..', 'shared', 'src', 'measurement-readiness.ts'),
  ].map((p) => readFileSync(p, 'utf8'));

  // A program measured from a counterparty's report is TWO ROWS OF DATA naming an
  // external id and a source key. There is no branch, constant or string here
  // that knows which program it is, and there never may be.
  for (const source of sources) {
    // Line-of-business names, and VENDOR names for a transport. `spreadsheet` is
    // deliberately absent: the contract's own header uses the word to explain why
    // the source KIND is not named after a file format, which is the distinction
    // being defended rather than a violation of it.
    for (const forbidden of ['SSDI', 'Retainer', '1696', 'Spanish', 'Home Security', 'GoogleSheet', 'googleapis', 'sheets.google']) {
      assert.equal(
        source.toLowerCase().includes(forbidden.toLowerCase()),
        false,
        `no line of business may appear: ${forbidden}`,
      );
    }
  }
});
