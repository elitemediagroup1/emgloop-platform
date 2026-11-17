import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseTtoReport } from '../../../packages/providers/src/tiktok-business/public-insights';
import { createTimeView } from '@emgloop/shared';
import { CreatorConnectedTikTokAnalytics, matchingTikTokHandles, selectTikTokAnalyticsSource } from '../src/creator/creator-connected-tiktok-analytics';
import type { TikTokEntryView } from '../src/app/app/creator/_parts/tiktok-connection';

const now = new Date('2026-11-17T16:00:00Z');
const time = createTimeView({ timeZone: 'America/New_York', source: 'device' }, now);
const entry: TikTokEntryView = {
  handle: 'chefmattdunn', profileUrl: 'https://www.tiktok.com/@chefmattdunn', seeded: false,
  readAt: now, stats: { followers: 1284, following: 40, likes: 22400, videos: 209 },
  recentVideos: [{ id: 'test', title: '<script>Pie</script>', shareUrl: 'https://www.tiktok.com/@chefmattdunn/video/123456', createdAt: now, viewCount: 0, likeCount: null }],
};
test('connected, partial, expired and failed status reads never silently default to another account source', () => {
  for (const state of ['CONNECTED', 'PARTIAL', 'EXPIRED', null] as const) assert.equal(selectTikTokAnalyticsSource(null, state), 'ACCOUNT');
  assert.equal(selectTikTokAnalyticsSource(null, 'NOT_CONNECTED'), 'TIKTOK_ONE');
  assert.equal(selectTikTokAnalyticsSource('TIKTOK_ONE', 'CONNECTED'), 'TIKTOK_ONE');
  assert.equal(selectTikTokAnalyticsSource('ACCOUNT', 'NOT_CONNECTED'), 'ACCOUNT');
  assert.equal(selectTikTokAnalyticsSource('arbitrary-account-id', 'CONNECTED'), 'ACCOUNT');
});
test('connected analytics identifies the authorized account, preserves missing counts and marks failed refreshes', () => {
  const html = renderToStaticMarkup(<CreatorConnectedTikTokAnalytics entry={entry} state="CONNECTED" readFailed time={time} />);
  assert.match(html, /@chefmattdunn/);
  assert.match(html, /1,284/);
  assert.match(html, /22\.4K/);
  assert.match(html, /last saved reading/);
  assert.match(html, /<td>0<\/td>/);
  assert.match(html, /Not provided/);
  assert.doesNotMatch(html, /176\.8K|938|<script>/);
  assert.match(html, /&lt;script&gt;Pie/);
});
test('revoked, expired or demo account data cannot render saved account metrics', () => {
  for (const state of ['NOT_CONNECTED', 'EXPIRED', null] as const) {
    const html = renderToStaticMarkup(<CreatorConnectedTikTokAnalytics entry={entry} state={state} readFailed time={time} />);
    assert.doesNotMatch(html, /chefmattdunn|22\.4K/);
  }
  assert.doesNotMatch(renderToStaticMarkup(<CreatorConnectedTikTokAnalytics entry={{ ...entry, seeded: true }} state="CONNECTED" readFailed={false} time={time} />), /chefmattdunn|22\.4K/);
});


test('supplemental report matching rejects different, missing and malformed identities', () => {
  assert.equal(matchingTikTokHandles('@TrevonBassmaster', 'trevonbassmaster'), true);
  assert.equal(matchingTikTokHandles('chefmattdunn', 'trevonbassmaster'), false);
  assert.equal(matchingTikTokHandles(null, null), false);
  assert.equal(matchingTikTokHandles('Trevon Hill', 'Trevon Hill'), false);
});

test('only same-account TikTok One metrics supplement the connected report', () => {
  const report = (handle: string) => ({
    report: parseTtoReport(handle, { creator_id: '12345', handle_name: handle, followers_count: 176800, median_views: 938 }, { posts: [] }, now),
    lastReadAt: now, stale: true,
  });
  const mismatch = renderToStaticMarkup(<CreatorConnectedTikTokAnalytics entry={entry} state="CONNECTED" readFailed={false} time={time} publicReport={report('trevonbassmaster')} />);
  assert.match(mismatch, /does not match this connected account/);
  assert.doesNotMatch(mismatch, /176\.8K|Supplemental TikTok One report/);
  const same = renderToStaticMarkup(<CreatorConnectedTikTokAnalytics entry={{ ...entry, handle: 'trevonbassmaster' }} state="CONNECTED" readFailed={false} time={time} publicReport={report('trevonbassmaster')} />);
  assert.match(same, /Supplemental TikTok One report/);
  assert.match(same, /Refresh pending/);
  assert.doesNotMatch(same, /176\.8K|does not match/);
});
