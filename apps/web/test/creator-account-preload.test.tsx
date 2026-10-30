import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseCreatorAudienceDisplay, createTimeView } from '@emgloop/shared';
import { ObservedTikTokReport } from '../src/creator/observed-tiktok-report';
test('displayed public counts retain exact versus rounded provenance; blanks and invalid ranges are unknown',()=>{
 assert.deepEqual(parseCreatorAudienceDisplay('19,267'),{count:19267,displayed:'19,267',rounded:false});
 assert.deepEqual(parseCreatorAudienceDisplay('176.9K'),{count:176900,displayed:'176.9K',rounded:true});
 assert.deepEqual(parseCreatorAudienceDisplay('6.97K'),{count:6970,displayed:'6.97K',rounded:true});
 for(const raw of ['','unknown','19,26','-1','1e6','0.1','2.2B','<script>']) assert.equal(parseCreatorAudienceDisplay(raw),null);
 assert.equal(parseCreatorAudienceDisplay('0')?.count,0);
});
test('the creator sees the actual sample basis and observation date, not a calendar-window total or mailbox reference',()=>{
 const time=createTimeView({timeZone:'America/New_York',source:'device'},new Date('2026-10-30T19:00:00Z'));
 const html=renderToStaticMarkup(<ObservedTikTokReport preferences={{managedMailboxEmail:'private@example.test',tiktokOneObservation:{sourceUrl:'https://private.example.test',basis:'30 most recent videos',observedAt:'2026-10-30T18:59:00Z',medianViewsDisplayed:'942',engagementPct:5.5,view6sPct:44.23}}} time={time}/>);
 assert.match(html,/30 most recent videos/); assert.match(html,/manually collected snapshot/); assert.match(html,/942/);
 assert.doesNotMatch(html,/private@example|private.example|total views/i);
 assert.equal(renderToStaticMarkup(<ObservedTikTokReport preferences={{}} time={time}/>),'');
});
