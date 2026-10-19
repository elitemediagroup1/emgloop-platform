import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIEFING_SCHEMA, estimateAiInputTokens } from '@emgloop/shared';
import { briefingContextOf, briefingAbsenceJustified, fitBriefingArtifacts, gapLimitations, type BriefingArtifact } from '../src/services/intelligence-fabric/briefing';
import { renderBriefingInstructions, renderBriefingRepairInstructions } from '../src/services/ai-runtime/templates/briefing';
import { AI_BUDGET_POLICY } from '@emgloop/providers';

const artifact = (ref: string, length: number, domain = 'MAIL'): BriefingArtifact => ({ ref, domain, title: domain, statement: 'x'.repeat(length), signals: [], basis: ref, coverage: 'CONNECTED_PARTIAL', limitations: ['Only the supplied records were read.'], status: 'WATCH' });
function estimate(artifacts: readonly BriefingArtifact[], gaps: Parameters<typeof gapLimitations>[0], repair = '') {
  const { items } = briefingContextOf(artifacts, 'our-org');
  return estimateAiInputTokens([renderBriefingInstructions(items.map((i) => i.sourceRef), { absenceJustified: briefingAbsenceJustified(artifacts, gaps), gaps: gapLimitations(gaps) }) + repair, JSON.stringify(BRIEFING_SCHEMA), ...items.flatMap((i) => [i.sourceRef, i.trust, i.content])]);
}
test('the former 24,000-character artifact allowance can exceed policy; fitting accounts for schema and instructions', () => {
  const artifacts = Array.from({ length: 6 }, (_, i) => artifact(`digest:${i}`, 3800));
  const cap = AI_BUDGET_POLICY.classes['loop-briefing']!.maxInputTokensPerCall;
  assert.ok(estimate(artifacts, []) > cap);
  const fitted = fitBriefingArtifacts(artifacts, [], 'our-org');
  assert.ok(fitted.artifacts.length > 0);
  assert.ok(fitted.artifacts.length < artifacts.length);
  assert.ok(estimate(fitted.artifacts, fitted.gaps) <= cap - 500);
  assert.ok(estimate(fitted.artifacts, fitted.gaps, renderBriefingRepairInstructions('', Array(6).fill('UNSUPPORTED_NUMBER_IN_TEXT'), Array.from({ length: 8 }, (_, index) => ({ field: 'line.statement' as const, index, actual: 10000, maximum: 240 })))) <= cap);
  const repair = renderBriefingRepairInstructions('', Array(6).fill('UNSUPPORTED_NUMBER_IN_TEXT'), Array.from({ length: 8 }, (_, index) => ({ field: 'line.statement' as const, index, actual: 10000000, maximum: 240 })));
  assert.ok(Math.ceil(repair.length / 2) <= 500, 'bounded feedback must fit the reserved repair headroom even when initial context fills its allowance');
  assert.equal(fitted.gaps.filter((g) => g.domain === 'MAIL' && g.reason === 'CONTEXT_LIMIT').length, 1);
  assert.equal(briefingAbsenceJustified(fitted.artifacts, fitted.gaps), false);
});
test('one oversized artifact cannot evict all readable evidence; current call evidence survives before a historical baseline', () => {
  const oversized = artifact('digest:large', 40000);
  const current = artifact('snapshot:callgrid', 1000, 'CALLGRID');
  const baseline = artifact('snapshot:callgrid:baseline', 13000, 'CALLGRID');
  const mail = artifact('digest:mail', 2000);
  const fitted = fitBriefingArtifacts([oversized, current, mail, baseline], [], 'our-org');
  assert.ok(!fitted.artifacts.includes(oversized));
  assert.ok(!fitted.artifacts.includes(baseline));
  assert.ok(fitted.artifacts.includes(current));
  assert.ok(fitted.artifacts.includes(mail));
  assert.ok(estimate(fitted.artifacts, fitted.gaps) <= 9500);
  assert.deepEqual(fitBriefingArtifacts(fitted.artifacts, fitted.gaps, 'our-org'), fitted);
});

test('numeric grounding uses the exact supplied artifact, including titles and limitations, but not hidden metadata', () => {
  const source: BriefingArtifact = { ...artifact('digest:campaign', 0, 'CAMPAIGNS'),
    title: 'SSDI - 1696', statement: 'Volume increased.', basis: 'private-basis-987654 2031-01-02',
    limitations: ['Revenue is reported on 22 calls.'], signals: [{ kind: 'CHANGE', statement: 'A measured signal.', metric: { value: 35 } }] };
  const other = { ...artifact('digest:other', 0), statement: '77 calls.' };
  const { items, evidence } = briefingContextOf([source, other], 'our-org');
  const figures = evidence.figures.get(source.ref)!;
  assert.ok(items[0]!.content.includes('1696'));
  assert.ok(figures.has(1696) && figures.has(22) && figures.has(35));
  assert.ok(!figures.has(77), 'another artifact cannot support an uncited figure');
  assert.ok(!figures.has(987654), 'internal basis was never supplied');
  assert.ok(!evidence.dates.has('2031-01-02'), 'hidden metadata is not date evidence either');
});

test('fitting preserves domain breadth before additional chat detail', () => {
  const chats = Array.from({ length: 8 }, (_, i) => artifact(`chat:${i}`, 3000, 'CHATS'));
  const creators = artifact('digest:creators', 800, 'CREATORS');
  const website = artifact('digest:website', 800, 'WEBSITE');
  const fitted = fitBriefingArtifacts([...chats, creators, website], [], 'our-org');
  assert.ok(fitted.artifacts.includes(creators));
  assert.ok(fitted.artifacts.includes(website));
  assert.ok(fitted.artifacts.some((a) => a.domain === 'CHATS'));
  assert.ok(fitted.gaps.some((g) => g.domain === 'CHATS' && g.reason === 'CONTEXT_LIMIT'));
});
