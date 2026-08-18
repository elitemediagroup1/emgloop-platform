// Source authority — a source holding a field is not a source to be believed.
//
// The case behind every assertion: on 2026-08-05 all 974 provider records carried
// `converted=false`. Not absent — present, and false — because the counterparty
// settles the next day and never tells the provider. A conversion rate computed
// from that field would have been 0% at full coverage, would have cleared every
// coverage guard Stage 3 has, and would have been wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MEASUREMENT_SOURCE_KINDS,
  isAuthorityDeclarationValid,
  measureDefinitionId,
  outcomeDataAvailable,
  resolveAuthority,
  sourceSupports,
  type MeasureSourceAuthorityDeclaration,
  type MeasurementSourceDefinition,
} from '../src/index';

const PROVIDER: MeasurementSourceDefinition = {
  key: 'provider-calls',
  kind: 'PROVIDER_STREAM',
  displayName: 'Call provider',
  supportedMetrics: ['CALL_VOLUME', 'REVENUE', 'NO_ROUTE_RATE'],
  measureDefinitionIds: {
    CALL_VOLUME: 'calls.provider.v1',
    REVENUE: 'revenue.provider.v1',
    NO_ROUTE_RATE: 'no-route.provider.v1',
  },
  provider: 'callgrid',
  stream: 'calls',
};

const REPORT: MeasurementSourceDefinition = {
  key: 'buyer-outcomes',
  kind: 'BUYER_REPORT',
  displayName: 'Buyer outcome report',
  supportedMetrics: ['REVENUE', 'CONVERSION_RATE'],
  measureDefinitionIds: { REVENUE: 'revenue.buyer.v1', CONVERSION_RATE: 'conversion.buyer.v1' },
  provider: null,
  stream: null,
};

function authority(
  over: Partial<MeasureSourceAuthorityDeclaration> = {},
): MeasureSourceAuthorityDeclaration {
  return {
    dimension: 'CAMPAIGN',
    memberExternalId: 'camp-a',
    metric: 'REVENUE',
    sourceKey: 'provider-calls',
    effectiveFrom: '2026-08-01',
    effectiveTo: null,
    ...over,
  };
}

// --- 1. What a source may be believed about ------------------------------------------

test('a source supplies a measure only when it declares BOTH support and a definition', () => {
  assert.equal(sourceSupports(PROVIDER, 'REVENUE'), true);
  assert.equal(sourceSupports(PROVIDER, 'CONVERSION_RATE'), false, 'not in supportedMetrics');
  assert.equal(
    sourceSupports(
      { ...PROVIDER, supportedMetrics: ['CONVERSION_RATE'], measureDefinitionIds: {} },
      'CONVERSION_RATE',
    ),
    false,
    'claimed without a definition is not a claim',
  );
});

test('two sources describing the same measure differently do not share a definition', () => {
  assert.notEqual(
    measureDefinitionId(PROVIDER, 'REVENUE'),
    measureDefinitionId(REPORT, 'REVENUE'),
    'this inequality is what stops them being summed',
  );
  assert.equal(measureDefinitionId(PROVIDER, 'CONVERSION_RATE'), null);
});

test('the kind names what a source IS, not how it travels', () => {
  assert.deepEqual([...MEASUREMENT_SOURCE_KINDS], ['PROVIDER_STREAM', 'BUYER_REPORT']);
  assert.equal(
    MEASUREMENT_SOURCE_KINDS.some((k) => /SHEET|CSV|EMAIL|GOOGLE/i.test(k)),
    false,
    'a transport in the domain model would need renaming the first time the format changed',
  );
});

// --- 2. Authority fails closed in both directions --------------------------------------

test('no declaration is MISSING — never "assume the provider"', () => {
  const r = resolveAuthority([], 'CAMPAIGN', 'camp-a', 'REVENUE', '2026-08-05');
  assert.equal(r.outcome, 'MISSING');
  assert.equal(r.sourceKey, null);
});

test('two declarations are a CONFLICT, and no tie-break is invented', () => {
  const r = resolveAuthority(
    [authority(), authority({ sourceKey: 'buyer-outcomes' })],
    'CAMPAIGN',
    'camp-a',
    'REVENUE',
    '2026-08-05',
  );
  assert.equal(r.outcome, 'CONFLICT');
  assert.equal(r.sourceKey, null);
  assert.equal(r.matches, 2);
});

test('one declaration resolves', () => {
  const r = resolveAuthority([authority()], 'CAMPAIGN', 'camp-a', 'REVENUE', '2026-08-05');
  assert.equal(r.outcome, 'RESOLVED');
  assert.equal(r.sourceKey, 'provider-calls');
});

test('authority is per measure: the same campaign can split across sources', () => {
  const rows = [
    authority({ metric: 'CALL_VOLUME', sourceKey: 'provider-calls' }),
    authority({ metric: 'REVENUE', sourceKey: 'buyer-outcomes' }),
  ];
  assert.equal(resolveAuthority(rows, 'CAMPAIGN', 'camp-a', 'CALL_VOLUME', '2026-08-05').sourceKey, 'provider-calls');
  assert.equal(resolveAuthority(rows, 'CAMPAIGN', 'camp-a', 'REVENUE', '2026-08-05').sourceKey, 'buyer-outcomes');
  assert.equal(resolveAuthority(rows, 'CAMPAIGN', 'camp-a', 'CONVERSION_RATE', '2026-08-05').outcome, 'MISSING');
});

test('a malformed declaration is ignored rather than obeyed', () => {
  assert.equal(isAuthorityDeclarationValid(authority({ sourceKey: '' })), false);
  assert.equal(
    resolveAuthority([authority({ sourceKey: '' })], 'CAMPAIGN', 'camp-a', 'REVENUE', '2026-08-05').outcome,
    'MISSING',
  );
});

test('a past day resolves the authority that was in force THEN', () => {
  // A program changes buyer. Re-running last month's comparison must not silently
  // acquire this month's meaning.
  const rows = [
    authority({ sourceKey: 'provider-calls', effectiveFrom: '2026-01-01', effectiveTo: '2026-08-10' }),
    authority({ sourceKey: 'buyer-outcomes', effectiveFrom: '2026-08-10', effectiveTo: null }),
  ];
  assert.equal(resolveAuthority(rows, 'CAMPAIGN', 'camp-a', 'REVENUE', '2026-08-05').sourceKey, 'provider-calls');
  assert.equal(resolveAuthority(rows, 'CAMPAIGN', 'camp-a', 'REVENUE', '2026-08-09').sourceKey, 'provider-calls');
  assert.equal(resolveAuthority(rows, 'CAMPAIGN', 'camp-a', 'REVENUE', '2026-08-10').sourceKey, 'buyer-outcomes');
});

// --- 3. Arriving data ---------------------------------------------------------------------

test('only a COMPLETE report may be measured from', () => {
  assert.equal(outcomeDataAvailable('COMPLETE'), true);
  assert.equal(outcomeDataAvailable('PARTIAL'), false, 'unmatched rows make the total unknown, not smaller');
  assert.equal(outcomeDataAvailable('PENDING'), false);
  assert.equal(outcomeDataAvailable('SUPERSEDED'), false);
  assert.equal(outcomeDataAvailable(null), false);
  assert.equal(outcomeDataAvailable(undefined), false);
});
