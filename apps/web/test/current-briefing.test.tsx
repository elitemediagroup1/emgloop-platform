import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefingComposer, WorkBriefRepository, briefingFingerprint, BRIEFING_MAX_AGE_MS, type BriefingArtifact } from '@emgloop/database';
import { createTimeView, resolveDisplayTimeZone } from '@emgloop/shared';
import { currentBriefingOf, loadStoredBriefing } from '../src/intelligence/briefing';
import { BusinessHeadlinesCard } from '../src/app/app/_home/front-door-view';
import { StoredBriefingBody } from '../src/app/app/_home/briefing-view';

const now = new Date('2026-10-16T01:30:00Z');
const day = '2026-10-15';
const a: BriefingArtifact = { ref: 'snapshot:callgrid', domain: 'CALLGRID', title: 'CallGrid', statement: '475 stored calls.', basis: 'current', status: 'WATCH', signals: [], coverage: 'CONNECTED_PARTIAL', limitations: ['Source amounts have not been reconciled.'] };
const row = { localDate: new Date('2026-10-15T00:00:00Z'), headline: 'AI summary.', items: [{ kind: 'WATCH', statement: '475 stored calls.', citations: [a.ref] }], coverage: { schema: 'loop-briefing.v1', composer: 'MODEL', fingerprint: briefingFingerprint(day, [a], []), refs: { [a.ref]: 'CALLGRID' } }, generatedAt: now };

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


test('new calls retain a recent AI reading explicitly as of its original time, beside current facts', () => {
  const later = new Date(now.getTime() + 60_000);
  const stored = currentBriefingOf(row, day, [{ ...a, basis: 'new-call', statement: '476 stored calls.' }], [], later)!;
  assert.equal(stored.composer, 'RULE');
  assert.match(stored.lines[0]!.statement, /476/);
  assert.equal(stored.asOfSummary!.composer, 'MODEL');
  assert.equal(stored.asOfSummary!.generatedAt, now);
  assert.match(stored.asOfSummary!.lines[0]!.statement, /475/);
  const time = createTimeView(resolveDisplayTimeZone({ preference: 'America/New_York', device: null }), later);
  const html = renderToStaticMarkup(<StoredBriefingBody stored={stored} time={time} offers={() => false} />);
  assert.match(html, /AI briefing as of/);
  assert.match(html, /9:30 PM/);
  assert.match(html, /Current recorded facts/);
  assert.match(html, /data-briefing-current-facts/);
  assert.doesNotMatch(html, /<details[^>]*data-briefing-current-facts[^>]* open/);
});

test('old, future, another-day or withdrawn evidence cannot reappear through the historical summary', () => {
  for (const previous of [
    { ...row, generatedAt: new Date(now.getTime() - 30 * 60_000) },
    { ...row, generatedAt: new Date(now.getTime() + 1) },
    { ...row, localDate: new Date('2026-10-14T00:00:00Z') },
  ]) assert.equal(currentBriefingOf(null, day, [a], [], now, previous)!.asOfSummary, undefined);
  assert.equal(currentBriefingOf(null, day, [{ ...a, ref: 'different-authorized-artifact' }], [], now, row)!.asOfSummary, undefined);
});

test('a later rule fallback preserves the last model, while any disappeared context hides the entire historical answer', () => {
  const privateRef = 'digest:private-chat';
  const previous = { ...row, headline: 'Private thread detail must disappear.',
    items: [...row.items, { kind: 'WATCH', statement: 'Private thread detail.', citations: [privateRef] }],
    coverage: { ...row.coverage, refs: { ...row.coverage.refs, [privateRef]: 'CHATS' } } };
  const rule = { ...row, coverage: { ...row.coverage, composer: 'RULE' } };
  const stored = currentBriefingOf(rule, day, [{ ...a, basis: 'changed' }], [], now, previous)!;
  assert.equal(stored.asOfSummary, undefined);
  const retained = currentBriefingOf(rule, day, [{ ...a, basis: 'changed' }], [], now, row)!;
  assert.equal(retained.asOfSummary!.headline, row.headline);
  assert.equal(currentBriefingOf(rule, day, [a], [], now, row)!.asOfSummary!.headline, row.headline, 'a matching fresh RULE still carries the earlier AI reading');
  const indirect = { ...previous, items: row.items };
  assert.equal(currentBriefingOf(rule, day, [a], [], now, indirect)!.asOfSummary, undefined, 'an uncited private context item still fences the entire historical answer');
});


test('stale but still-authorized source history remains explicitly historical, while loss of access hides it', () => {
  const stale = [{ domain: 'CALLGRID', coverage: 'STALE' as const }];
  const old = currentBriefingOf(null, day, [], stale, now, row, [a.ref])!;
  assert.equal(old.composer, 'RULE');
  assert.equal(old.asOfSummary!.headline, row.headline);
  assert.equal(currentBriefingOf(null, day, [], stale, now, row, [])!.asOfSummary, undefined);
});


test('compact Home briefings preserve the complete answer behind an accessible disclosure', () => {
  const stored = { headline: 'Current business summary.', composer: 'MODEL' as const, generatedAt: now,
    limitations: ['Mail is partial.'], lines: Array.from({ length: 6 }, (_, i) => ({kind: 'WATCH' as const, statement: `Observation ${i + 1}.`, parts: ['CALLGRID']})) };
  const time = createTimeView(resolveDisplayTimeZone({ preference: 'America/New_York', device: null }), now);
  const html = renderToStaticMarkup(<StoredBriefingBody stored={stored} time={time} offers={() => false} compact />);
  const beforeMore = html.slice(0, html.indexOf('data-briefing-more'));
  assert.equal((beforeMore.match(/data-briefing-line=/g) ?? []).length, 3);
  assert.equal((html.match(/data-briefing-line=/g) ?? []).length, 6, 'no observation is dropped');
  assert.match(html, /More from this briefing \(3\)/);
  assert.doesNotMatch(html, /<details[^>]*data-briefing-more[^>]* open/);
  assert.match(html, /Mail is partial/);
});


test('Headlines keeps business readings separate from daily priorities without manufacturing connections', () => {
  const stored = { headline: 'Shared summary.', composer: 'MODEL' as const, generatedAt: now,
    limitations: ['Mail is partial.'], lines: [
      { kind: 'NEEDS_YOU' as const, statement: 'Reply to the buyer.', parts: ['MAIL'] },
      { kind: 'INSIGHT' as const, statement: 'Volume rose while the buyer reported constrained capacity; this could limit monetization, but the cause is unconfirmed.', parts: ['CALLGRID', 'CHATS'] },
    ] };
  const time = createTimeView(resolveDisplayTimeZone({ preference: 'America/New_York', device: null }), now);
  const daily = renderToStaticMarkup(<StoredBriefingBody stored={stored} time={time} offers={() => false} purpose="daily" />);
  assert.match(daily, /Reply to the buyer/);
  assert.doesNotMatch(daily, /Volume rose/);
  const headlines = renderToStaticMarkup(<BusinessHeadlinesCard stored={stored} situations={null} time={time} offers={() => false} />);
  assert.match(headlines, /aria-label="Headlines"/);
  assert.doesNotMatch(headlines, /AI Headlines|Reply to the buyer|Connected signals/);
  assert.match(headlines, /Volume rose/);
  assert.match(headlines, /Mail is partial/);
  assert.match(headlines, /AI reading as of/);
  assert.match(headlines, /data-briefing-chip="CALLGRID"/);
  assert.doesNotMatch(headlines, /href="\/app/);
});

test('Headlines never presents rule fallback or historical KPI recaps as connected insights', () => {
  const time = createTimeView(resolveDisplayTimeZone({ preference: 'America/New_York', device: null }), now);
  const rule = currentBriefingOf(null, day, [a], [], now)!;
  const pending = renderToStaticMarkup(<BusinessHeadlinesCard stored={rule} situations={null} time={time} offers={() => false} />);
  assert.match(pending, /data-headlines-ai-pending/);
  assert.doesNotMatch(pending, /475 stored calls/);
  const historical = currentBriefingOf(null, day, [{ ...a, basis: 'changed' }], [], now, row)!;
  const shown = renderToStaticMarkup(<BusinessHeadlinesCard stored={historical} situations={null} time={time} offers={() => false} />);
  assert.match(shown, /data-headlines-ai-pending/);
  assert.doesNotMatch(shown, /475 stored calls/, 'an old KPI recap is not a connected insight');
});


test('Headlines does not relabel an ordinary briefing as a connected insight', () => {
  const time = createTimeView(resolveDisplayTimeZone({ preference: 'America/New_York', device: null }), now);
  const stored = { headline: 'The capacity conversation overlaps with rising call volume.', composer: 'MODEL' as const,
    generatedAt: now, limitations: ['The relationship is unconfirmed.'],
    lines: [{ kind: 'NEEDS_YOU' as const, statement: 'The buyer is waiting on your reply.', parts: ['CHATS'] }] };
  const html = renderToStaticMarkup(<BusinessHeadlinesCard stored={stored} situations={null} time={time} offers={() => false} />);
  assert.match(html, /data-headlines-ai-pending/);
  assert.doesNotMatch(html, /The buyer is waiting|data-briefing-headline/);
});

test('a connected business insight retains publication dates and clickable attribution', () => {
  const stored = { headline: 'Search changes could affect the observed traffic mix.', composer: 'MODEL' as const, generatedAt: now, limitations: ['Article body not verified.'], lines: [{ kind: 'INSIGHT' as const, statement: 'Search traffic and a published platform change could overlap; its effect on EMG is unconfirmed.', parts: ['WEBSITE', 'EXTERNAL_NEWS'], publications: [{ title: 'Google Ads · publication 2026-10-15', url: 'https://blog.google/products/ads-commerce/example' }] }] };
  const time = createTimeView(resolveDisplayTimeZone({ preference: 'America/New_York', device: null }), now);
  const html = renderToStaticMarkup(<BusinessHeadlinesCard stored={stored} situations={null} time={time} offers={() => false} />);
  assert.match(html, /What this could mean/);
  assert.match(html, /publication 2026-10-15/);
  assert.match(html, /href="https:\/\/blog.google/);
  assert.match(html, /rel="noopener noreferrer"/);
});


test('a full login session is narrowed to the signed principal before any briefing query or gather', async (t) => {
  const expected = { organizationId: 'signed-org', userId: 'signed-user' };
  const session = { ...expected, email: 'viewer@example.test', name: 'Viewer', systemRole: 'OWNER', roleLabel: 'Owner' };
  let reads = 0;
  t.mock.method(WorkBriefRepository.prototype, 'forDate', async (principal: typeof expected) => {
    assert.deepEqual(principal, expected);
    reads += 1;
    return row as never;
  });
  t.mock.method(BriefingComposer.prototype, 'gather', async (principal: typeof expected) => {
    assert.deepEqual(principal, expected);
    return { artifacts: [a], gaps: [] };
  });
  const reading = await loadStoredBriefing(session, 'America/New_York', now);
  assert.equal(reads, 1);
  assert.equal(reading?.composer, 'MODEL');
  assert.equal(reading?.headline, row.headline);
});
