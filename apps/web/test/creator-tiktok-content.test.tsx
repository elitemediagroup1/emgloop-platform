import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreatorTikTokContent } from '../src/creator/creator-tiktok-content';
import { parseTtoReport } from '../../../packages/providers/src/tiktok-business/public-insights';
import { createTimeView } from '@emgloop/shared';
test('creator panel uses actual content, preserves unknown counts and escapes provider text', () => {
    const now = new Date();
    const report = parseTtoReport('testcreator', { creator_id: '12345', handle_name: 'testcreator', followers_count: 0 }, { posts: [{ video_id: '123456', caption: '<script>bad</script>', thumbnail_url: 'https://p16.tiktokcdn.com/thumb.jpg' }] }, now);
    const html = renderToStaticMarkup(<CreatorTikTokContent report={report} lastReadAt={now} stale time={createTimeView({ timeZone: 'UTC', source: 'fallback' }, now)}/>);
    assert.match(html, /0 TikTok followers/);
    assert.match(html, /Views unavailable/);
    assert.match(html, /refresh pending/);
    assert.match(html, /https:\/\/www.tiktok.com\/@testcreator\/video\/123456/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /referrerPolicy="no-referrer"/i);
});
