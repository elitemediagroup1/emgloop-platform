import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIEFING_SCHEMA, estimateAiInputTokens } from '@emgloop/shared';
import { briefingContextOf, briefingAbsenceJustified, fitBriefingArtifacts, gapLimitations, type BriefingArtifact } from '../src/services/intelligence-fabric/briefing';
import { renderBriefingInstructions } from '../src/services/ai-runtime/templates/briefing';
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
  assert.ok(estimate(fitted.artifacts, fitted.gaps, '\nOne bounded repair after validation codes UNSUPPORTED_NUMBER, ANSWER_TOO_LONG. Use only the original supplied artifacts. Return fewer, shorter lines if necessary. Omit unsupported claims or figures. Do not recommend actions or infer that nothing needs attention from incomplete coverage. Return the exact required JSON shape.') <= cap);
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
