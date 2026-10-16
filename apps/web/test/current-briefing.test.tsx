import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { briefingFingerprint, BRIEFING_MAX_AGE_MS, type BriefingArtifact } from '@emgloop/database';
import { createTimeView, resolveDisplayTimeZone } from '@emgloop/shared';
import { currentBriefingOf } from '../src/intelligence/briefing';
import { StoredBriefingBody } from '../src/app/app/_home/briefing-view';

const now = new Date('2026-10-16T01:30:00Z');
const day = '2026-10-15';
const a: BriefingArtifact = { ref: 'snapshot:callgrid', domain: 'CALLGRID', title: 'CallGrid', statement: '475 stored calls.', basis: 'current', status: 'WATCH', signals: [], coverage: 'CONNECTED_PARTIAL', limitations: ['Source amounts have not been reconciled.'] };
const row = { headline: 'AI summary.', items: [{ kind: 'WATCH', statement: '475 stored calls.', citations: [a.ref] }], coverage: { schema: 'loop-briefing.v1', composer: 'MODEL', fingerprint: briefingFingerprint(day, [a], []), refs: { [a.ref]: 'CALLGRID' } }, generatedAt: now };

test('matching current evidence may show the stored model summary, but changed totals or gaps cannot', () => {
  assert.equal(currentBriefingOf(row, day, [a], [], now)!.composer, 'MODEL');
  const changed = currentBriefingOf(row, day, [{ ...a, basis: 'new-call', statement: '476 stored calls.' }], [], now)!;
  assert.equal(changed.composer, 'RULE');
  assert.match(changed.lines[0]!.statement, /476 stored calls/);
  assert.doesNotMatch(changed.lines[0]!.statement, /475/);
  assert.equal(currentBriefingOf(row, day, [a], [{ domain: 'MAIL', coverage: 'STALE' }], now)!.composer, 'RULE');
});
test('a four-hour-old or future-dated summary cannot lead as current; absent evidence cannot revive old private content', () => {
  assert.equal(currentBriefingOf({ ...row, generatedAt: new Date(now.getTime() - 4 * 3600000) }, day, [a], [], now)!.composer, 'RULE');
  assert.equal(currentBriefingOf(row, day, [a], [], new Date(now.getTime() + BRIEFING_MAX_AGE_MS))!.composer, 'RULE');
  assert.equal(currentBriefingOf({ ...row, generatedAt: new Date(now.getTime() + 1) }, day, [a], [], now)!.composer, 'RULE');
  assert.equal(currentBriefingOf(row, day, [], [], now), null);
});
test('coverage remains available in collapsed details rather than an inline wall of caveats', () => {
  const stored = currentBriefingOf(null, day, [a], [], now)!;
  const time = createTimeView(resolveDisplayTimeZone({ preference: 'America/New_York', device: null }), now);
  const html = renderToStaticMarkup(<StoredBriefingBody stored={stored} time={time} offers={() => false} />);
  assert.match(html, /<details[^>]*data-briefing-limitations/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(html, /Source amounts have not been reconciled/);
  assert.match(html, /not an AI-composed summary/);
});
