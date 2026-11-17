import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreatorPerformanceInsights, performanceSample } from '../src/creator/creator-performance-insights';

test('sample insights exclude missing values, preserve zero, and use only paired counts for like rate', () => {
  const videos = [
    { id: 'a', title: 'First', url: null, views: 1000, likes: 10 },
    { id: 'b', title: 'Second', url: null, views: 3000, likes: null },
    { id: 'c', title: 'Unknown', url: null, views: null, likes: 1000 },
    { id: 'd', title: 'Zero', url: null, views: 0, likes: 0 },
  ];
  const sample = performanceSample(videos);
  assert.equal(sample.views, 4000);
  assert.equal(sample.known, 3);
  assert.equal(sample.likeRate, 1);
  assert.equal(sample.ranked[0]?.id, 'b');
  const html = renderToStaticMarkup(<CreatorPerformanceInsights videos={videos} source="Connected TikTok" />);
  assert.match(html, /3 of 4 videos/);
  assert.match(html, /not a 30-day report/);
  assert.match(html, /Highest views in this sample/);
  assert.doesNotMatch(html, /Infinity|NaN|growth|AI insight/i);
});
test('empty and zero samples do not invent trends or a like rate', () => {
  assert.equal(performanceSample([]).views, null);
  assert.equal(performanceSample([{ id: '0', title: null, url: null, views: 0, likes: 0 }]).likeRate, null);
  const html = renderToStaticMarkup(<CreatorPerformanceInsights videos={[]} source="TikTok One" />);
  assert.doesNotMatch(html, /<li|NaN|Infinity/);
  assert.match(html, /Missing counts are not treated as zero/);
});
