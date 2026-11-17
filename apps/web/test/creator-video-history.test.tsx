import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTimeView } from '@emgloop/shared';
import { CreatorVideoHistory, videoHistorySets } from '../src/creator/creator-video-history';
import { CreatorAudienceInsights } from '../src/creator/creator-audience-insights';
const time = createTimeView(
  { timeZone: 'America/New_York', source: 'device' },
  new Date('2026-11-17T12:00:00Z'),
);
test('newest 14 and imported top 10 are distinct, deduplicated sets with truthful coverage', () => {
  const videos = Array.from({ length: 40 }, (_, i) => ({
    id: String(i),
    title: 'Post ' + i,
    url: null,
    views: i,
    likes: 0,
    comments: 3,
    shares: 4,
    publishedAt: new Date(1700000000000 - i * 1000).toISOString(),
  }));
  const sets = videoHistorySets([...videos, videos[0]!]);
  assert.equal(sets.recent.length, 14);
  assert.equal(sets.recent[0]?.id, '0');
  assert.equal(sets.top.length, 10);
  assert.equal(sets.top[0]?.id, '39');
  const incomplete = renderToStaticMarkup(<CreatorVideoHistory videos={videos} time={time} />);
  assert.match(incomplete, /14 Newest Videos/);
  assert.match(incomplete, /<th>Comments<\/th>/);
  assert.match(incomplete, /<td>3<\/td><td>4<\/td>/);
  assert.match(incomplete, /Top 10 Among Imported Videos/);
  assert.doesNotMatch(incomplete, /Top 10 All-Time Videos/);
  assert.match(
    renderToStaticMarkup(<CreatorVideoHistory videos={videos} complete time={time} />),
    /Top 10 All-Time Videos/,
  );
});
test('audience renders reported fractional percentages and honest field-specific missing states', () => {
  const html = renderToStaticMarkup(
    <CreatorAudienceInsights
      audience={{
        followers: {
          ages: [{ label: '25-34', percentage: 0.65 }],
          genders: [],
          countries: [{ label: 'US', percentage: 0.9 }],
        },
        reached: { ages: [], genders: [], countries: [] },
        engaged: { ages: [], genders: [], countries: [] },
      }}
    />,
  );
  assert.match(html, /65.0%/);
  assert.match(html, /90.0%/);
  assert.match(html, /Gender breakdown was not returned/);
  assert.match(html, /past 30 days/);
  assert.doesNotMatch(html, /demographics.*not available/);
});
