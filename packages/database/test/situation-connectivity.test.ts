// Situation independence and source lineage, pure (2026-09-29). A cluster may reach synthesis only when its
// evidence rests on at least two DISTINCT GOVERNED SOURCES -- the registered source ids its digests' provenance
// names. CallGrid and Campaigns both read the one CALLGRID source (marketplace_calls): together they are one
// source seen twice. The real-record proofs are in situations.postgres.test.ts and
// governed-entity-links.postgres.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTELLIGENCE_SOURCE_REGISTRY, SITUATION_MAX_OPEN_CANDIDATES, SITUATION_MAX_SIGNALS, clusterSituationSignals, type SituationSignalInput } from '@emgloop/shared';

import { governedSourcesOf } from '../src/services/intelligence-fabric/situations';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const DAY = 864e5;
let n = 0;
const input = (domain: string, sources: string[], entities: string[], patch: Partial<SituationSignalInput> & { kind?: string; at?: number; severity?: string } = {}): SituationSignalInput => ({
  ref: `digest:d${(n += 1)}/k`,
  domain,
  signal: { key: 'k', kind: (patch.kind ?? 'RISK') as never, knowledge: 'OBSERVED', statement: 's', entities, evidenceRefs: ['x:y'], severity: (patch.severity ?? 'HIGH') as never },
  at: patch.at ?? NOW,
  sources,
});
const CAMP = 'provider_member:callgrid:campaign:c1';

test('the lineage: CallGrid and Campaigns are one governed source in the registry; every other organization domain has its own', () => {
  const sourceOf = (domain: string) => INTELLIGENCE_SOURCE_REGISTRY.filter((s) => (s.domains as readonly string[]).includes(domain)).map((s) => s.sourceId);
  assert.deepEqual(sourceOf('CALLGRID'), ['CALLGRID']);
  assert.deepEqual(sourceOf('CAMPAIGNS'), ['CALLGRID']);
  assert.deepEqual(sourceOf('CREATORS'), ['LOOP_CREATORS']);
  assert.deepEqual(sourceOf('WORK'), ['LOOP_WORK']);
  assert.deepEqual(sourceOf('CRM'), ['LOOP_CRM']);
  assert.ok(sourceOf('PIPELINE').includes('LOOP_INTAKE'));
});

test('a digest’s governed sources are the REGISTERED source ids of its provenance -- unknown or missing ids count for nothing', () => {
  const d = (sources: unknown) => ({ provenance: { sources } }) as never;
  assert.deepEqual(governedSourcesOf(d([{ sourceId: 'CALLGRID' }, { sourceId: 'CALLGRID' }])), ['CALLGRID']);
  assert.deepEqual(governedSourcesOf(d([{ sourceId: 'LOOP_WORK' }, { sourceId: 'MADE_UP' }, { sourceId: 7 }])), ['LOOP_WORK']);
  assert.deepEqual(governedSourcesOf(d(undefined)), []);
  assert.deepEqual(governedSourcesOf({ provenance: null } as never), []);
});

test('CallGrid + Campaigns on one source form a cross-domain cluster that is NOT independent', () => {
  const [c] = clusterSituationSignals([input('CALLGRID', ['CALLGRID'], [CAMP]), input('CAMPAIGNS', ['CALLGRID'], [CAMP])], []);
  assert.deepEqual([c!.domains, c!.sources, c!.independent], [['CALLGRID', 'CAMPAIGNS'], ['CALLGRID'], false]);
});

test('two genuinely different governed sources sharing an entity -- directly or through a governed link -- are independent', () => {
  const [direct] = clusterSituationSignals([input('WORK', ['LOOP_WORK'], [CAMP]), input('CAMPAIGNS', ['CALLGRID'], [CAMP])], []);
  assert.deepEqual([direct!.sources, direct!.independent], [['CALLGRID', 'LOOP_WORK'], true]);
  const [linked] = clusterSituationSignals([input('PIPELINE', ['LOOP_INTAKE'], ['customer:k1']), input('CREATORS', ['LOOP_CREATORS'], ['creator:r1'])], [['customer:k1', 'party:p1'], ['creator:r1', 'party:p1']]);
  assert.deepEqual([linked!.domains, linked!.sources, linked!.independent], [['CREATORS', 'PIPELINE'], ['LOOP_CREATORS', 'LOOP_INTAKE'], true]);
});

test('a signal with no registered source connects but never makes a cluster independent (fail closed)', () => {
  const [c] = clusterSituationSignals([input('CAMPAIGNS', ['CALLGRID'], [CAMP]), input('WORK', [], [CAMP])], []);
  assert.deepEqual([c!.domains, c!.sources, c!.independent], [['CAMPAIGNS', 'WORK'], ['CALLGRID'], false]);
});

test('kind and time still rule: a plain measurement or a signal outside the window never joins, whatever its source', () => {
  assert.deepEqual(clusterSituationSignals([input('CAMPAIGNS', ['CALLGRID'], [CAMP]), input('WORK', ['LOOP_WORK'], [CAMP], { kind: 'OPERATIONAL' })], []), []);
  assert.deepEqual(clusterSituationSignals([input('CAMPAIGNS', ['CALLGRID'], [CAMP]), input('WORK', ['LOOP_WORK'], [CAMP], { at: NOW - 15 * DAY })], []), []);
});

test('the signal cap can never drop the only evidence from a second source', () => {
  const many = Array.from({ length: SITUATION_MAX_SIGNALS + 4 }, () => input('CAMPAIGNS', ['CALLGRID'], [CAMP], { severity: 'HIGH' }));
  const [c] = clusterSituationSignals([...many, input('WORK', ['LOOP_WORK'], [CAMP], { severity: 'LOW' })], []);
  assert.equal(c!.items.length, SITUATION_MAX_SIGNALS);
  assert.deepEqual([c!.sources, c!.independent], [['CALLGRID', 'LOOP_WORK'], true]);
});

test('independent clusters rank first, so same-source clusters can never crowd them out of the candidate cap', () => {
  const sameSource = Array.from({ length: SITUATION_MAX_OPEN_CANDIDATES + 2 }, (_, i) => [input('CALLGRID', ['CALLGRID'], [`provider_member:callgrid:campaign:s${i}`]), input('CAMPAIGNS', ['CALLGRID'], [`provider_member:callgrid:campaign:s${i}`])]).flat();
  const independent = [input('WORK', ['LOOP_WORK'], ['work_instance:w1'], { severity: 'LOW' }), input('CAMPAIGNS', ['CALLGRID'], ['work_instance:w1'], { severity: 'LOW' })];
  const out = clusterSituationSignals([...sameSource, ...independent], []);
  assert.equal(out.length, SITUATION_MAX_OPEN_CANDIDATES);
  assert.equal(out[0]!.independent, true);
  assert.equal(clusterSituationSignals([...sameSource, ...independent], [], { limit: Number.MAX_SAFE_INTEGER }).length, SITUATION_MAX_OPEN_CANDIDATES + 3);
});
