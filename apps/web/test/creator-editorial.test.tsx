import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTimeView } from '@emgloop/shared';
import type { EarningsView, PublishedCreatorBrandUpdate } from '@emgloop/database';
import type { TtoReport } from '@emgloop/providers';
import { realCreatorEarnings } from '../src/creator/creator-earnings';
import { CreatorPartnershipBoard } from '../src/creator/creator-brand-updates';
import { CreatorTikTokAnalytics } from '../src/creator/creator-tiktok-analytics';
import { youtubePublishedMedia } from '../src/creator/creator-published-media';

const at = new Date('2026-11-14T01:00:00Z');
const time = createTimeView({ timeZone: 'America/New_York', source: 'device' }, at);
const entry = (id: string, currency: string, amountMinor: number, source = 'MANUAL_ENTRY') => ({
  id,
  description: id,
  currency,
  amountMinor,
  source,
  state: 'AVAILABLE' as const,
  stateLabel: 'Available',
  payable: true,
  occurredAt: at.toISOString(),
  campaignName: null,
  deliverableTitle: null,
});
test('production payment totals discard demonstration rows and isolate currencies', () => {
  const view: EarningsView = {
    currency: 'USD',
    totals: {
      EXPECTED: 0,
      PENDING: 0,
      RECEIVED_BY_EMG: 0,
      AVAILABLE: 999999,
      TRANSFER_PENDING: 0,
      PAID: 0,
    },
    availableMinor: 999999,
    payoutState: 'NOT_SET_UP',
    seeded: true,
    entries: [
      entry('real', 'USD', 1200),
      entry('demo', 'USD', 999000, 'SEEDED_DEMO'),
      entry('eu', 'EUR', 600),
    ],
  };
  const usd = realCreatorEarnings(view);
  assert.equal(usd.availableMinor, 1200);
  assert.deepEqual(
    usd.entries.map((e) => e.id),
    ['real'],
  );
  assert.equal(usd.seeded, false);
  assert.equal(realCreatorEarnings(view, 'EUR').availableMinor, 600);
  assert.equal(
    realCreatorEarnings({ ...view, entries: [entry('demo', 'USD', 999000, 'SEEDED_DEMO')] })
      .availableMinor,
    0,
  );
});
test('partnership board counts canonical brands once and keeps latest confirmed evidence in its own section', () => {
  const row: PublishedCreatorBrandUpdate = {
    id: '1',
    brandId: 'same',
    brand: 'Actual Brand',
    stage: 'OUTREACH',
    summary: 'A proposal was sent.',
    nextStep: 'Await reply.',
    generatedAt: at,
    evidenceAt: at,
    checkedAt: at,
    current: true,
  };
  const rows = [
    row,
    {
      ...row,
      id: '2',
      stage: 'CONFIRMED' as const,
      synthesized: true,
      summary: 'The agreement was accepted.',
    },
  ];
  const outreach = renderToStaticMarkup(
    <CreatorPartnershipBoard rows={rows} time={time} stage="0" query="" available />,
  );
  assert.doesNotMatch(outreach, /ch-brand-name/);
  const active = renderToStaticMarkup(
    <CreatorPartnershipBoard rows={rows} time={time} stage="2" query="actual" available />,
  );
  assert.equal((active.match(/class="ch-brand-name"/g) ?? []).length, 1);
  assert.match(active, /The agreement was accepted/);
  assert.doesNotMatch(active, /mail_message:|sourceFingerprint|recipientUserId/);
});
test('TikTok report preserves absent metrics and never fabricates a historical trend', () => {
  const report = { followers: 176800, medianViews: null, videos: [] } as unknown as TtoReport;
  const html = renderToStaticMarkup(
    <CreatorTikTokAnalytics report={report} updatedAt={at} stale time={time} />,
  );
  assert.match(html, /176.8K/);
  assert.match(html, /Not provided/);
  assert.match(html, /Refresh pending/);
  assert.match(html, /does not provide a historical audience series/);
  assert.doesNotMatch(html, /\+\d+%|942|938/);
});
test('YouTube gallery accepts only bounded real IDs and trusted thumbnail hosts', () => {
  const report = {
    topVideos: [
      {
        videoId: 'abcdefghijk',
        title: 'Real title',
        thumbnailUrl: 'https://i.ytimg.com/vi/abcdefghijk/default.jpg',
        metrics: { views: 0 },
      },
      { videoId: 'abcdefghijk', title: 'Duplicate', metrics: { views: 20 } },
      { videoId: 'javascript:alert(1)', title: 'Invalid' },
      {
        videoId: '12345678901',
        title: 'No trusted preview',
        thumbnailUrl: 'https://evil.example/image.jpg',
        metrics: { views: -2 },
      },
    ],
  };
  const rows = youtubePublishedMedia({
    connection: {
      id: 'yt-connection',
      connectedAt: at,
      lastSyncedAt: at,
      channelId: 'channel',
      channelTitle: 'Creator channel',
      subscriberCount: null,
      lifetimeViewCount: null,
      videoCount: null,
    },
    observation: { observedAt: at, report },
  } as Parameters<typeof youtubePublishedMedia>[0]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.views, 0);
  assert.equal(rows[1]?.views, null);
  assert.equal(rows[1]?.thumbnail, null);
  assert.equal(rows[0]?.url, 'https://www.youtube.com/watch?v=abcdefghijk');
});
