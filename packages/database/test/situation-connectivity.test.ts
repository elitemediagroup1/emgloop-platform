// The Situation connectivity diagnostic's pure half (2026-09-29): which references would form cross-domain
// components, and which of those rest on two distinct governed sources. The real-record proof is in
// situations.postgres.test.ts ("CONNECTIVITY: ...").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTELLIGENCE_SOURCE_REGISTRY } from '@emgloop/shared';

import { DOMAIN_SOURCE, potentialSituationComponents } from '../src/repositories/intelligence/situation-connectivity.repository';

const CAMP = 'provider_member:callgrid:campaign:c1';

test('two readings of the SAME source sharing a reference are cross-domain but not independent: the two-source rule removes them', () => {
  const p = potentialSituationComponents(
    [
      { domain: 'CALLGRID', source: 'CALLGRID', refs: [CAMP] },
      { domain: 'CAMPAIGNS', source: 'CALLGRID', refs: [CAMP] },
    ],
    [],
  );
  assert.deepEqual(p, { crossDomain: 1, independent: 0, eliminatedSameSource: 1, groups: [{ domains: ['CALLGRID', 'CAMPAIGNS'], sources: ['CALLGRID'], count: 1, independent: false }] });
});

test('a governed link joins references no domain shares; a joining reference nobody names still connects two that are named', () => {
  const p = potentialSituationComponents(
    [
      { domain: 'PIPELINE', source: 'LOOP_INTAKE', refs: ['customer:k1', 'customer:k2'] },
      { domain: 'CREATORS', source: 'LOOP_CREATORS', refs: ['creator:r1'] },
      { domain: 'CRM', source: 'LOOP_CRM', refs: ['party:p9'] },
    ],
    [
      ['customer:k1', 'party:p1'],
      ['creator:r1', 'party:p1'],
    ],
  );
  assert.deepEqual([p.crossDomain, p.independent, p.eliminatedSameSource], [1, 1, 0]);
  assert.deepEqual(p.groups, [{ domains: ['CREATORS', 'PIPELINE'], sources: ['LOOP_CREATORS', 'LOOP_INTAKE'], count: 1, independent: true }]);
});

test('nothing without a shared reference or a link: separate namespaces never connect; one domain alone is never a component', () => {
  const p = potentialSituationComponents(
    [
      { domain: 'CALLGRID', source: 'CALLGRID', refs: ['provider_member:callgrid:buyer:b1'] },
      { domain: 'CAMPAIGNS', source: 'CALLGRID', refs: [CAMP, 'provider_member:callgrid:campaign:c2'] },
      { domain: 'PIPELINE', source: 'LOOP_INTAKE', refs: [] },
    ],
    [[CAMP, 'provider_member:callgrid:campaign:c2']],
  );
  assert.deepEqual(p, { crossDomain: 0, independent: 0, eliminatedSameSource: 0, groups: [] });
});

test('the domain -> source map is the source registry’s: CALLGRID and CAMPAIGNS rest on the one marketplace_calls source', () => {
  for (const [domain, sourceId] of Object.entries(DOMAIN_SOURCE)) {
    const entry = INTELLIGENCE_SOURCE_REGISTRY.find((s: { sourceId: string }) => s.sourceId === sourceId) as { domains: readonly string[] } | undefined;
    assert.ok(entry, `${sourceId} is a registered source`);
    assert.ok(entry!.domains.includes(domain), `${sourceId} feeds ${domain}`);
  }
  assert.equal(DOMAIN_SOURCE.CALLGRID, DOMAIN_SOURCE.CAMPAIGNS);
});
