import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTimeView } from '@emgloop/shared';
import { CreatorAnalyticsCoach } from '../src/creator/creator-analytics-coach';
const now=new Date('2026-11-17T16:00:00Z'),time=createTimeView({timeZone:'America/New_York',source:'device'},now);
test('AI coach shows no fabricated feedback before a real accepted reading exists',()=>{
 const html=renderToStaticMarkup(<CreatorAnalyticsCoach review={null} source="ACCOUNT" time={time} outcome={null}/>);
 assert.match(html,/Your AI review is not available yet/);
 assert.doesNotMatch(html,/Request a review|Review my performance/);
 assert.doesNotMatch(html,/Where to improve|View supporting post/);
});
test('accepted coach feedback is escaped and tied to its saved supporting posts',()=>{
 const reading={reading:{statement:'A specific review',status:'QUIET',confidence:'LOW'},signals:['praise','critique','experiment'].map(key=>({key,kind:'OPPORTUNITY',knowledge:'INFERRED',statement:`${key} <script>unsafe</script>`,entities:[],evidenceRefs:['analytics_post:a'],occurredAt:null,dueAt:null,confidence:'LOW',severity:'LOW',owedBy:null})),limitations:['Captions and counts only.']};
 const html=renderToStaticMarkup(<CreatorAnalyticsCoach review={{reading,evidence:{posts:[{key:'a',url:'https://www.tiktok.com/@creator/video/123'}]},generatedAt:now}} source="ACCOUNT" time={time} outcome={null}/>);
 for(const title of ['What you’re doing well','Where to improve','Try this next'])assert.ok(html.includes(title));
 assert.match(html,/https:\/\/www.tiktok.com\/@creator\/video\/123/);
 assert.match(html,/&lt;script&gt;/);
 assert.doesNotMatch(html,/<script>/);
 assert.match(html,/AI interpretation, not a guaranteed outcome/);
});
