import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTtoReport, readTtoReport, ttoHandle, ttoImage, TtoPublicApi } from '../../providers/src/tiktok-business/public-insights';
import { TtoMediaService } from '../src/services/tiktok/tto-media.service';
import { TikTokBusinessService } from '../src/services/tiktok/tiktok-business.service';
import type { TtoMediaRepository } from '../src/repositories/tto-media.repository';
const now = new Date('2026-11-14T12:00:00Z');
const profile = { creator_id: '12345', handle_name: 'trevonbassmaster', display_name: 'Trevon', followers_count: 0, profile_image: 'https://p16.tiktokcdn.com/avatar.jpg' };
const media = { posts: [{ video_id: '123456789', caption: 'Real caption', create_time: String(+now - 10000), thumbnail_url: `https://p16.tiktokcdn.com/video.jpg?x-expires=${+now / 1000 + 60}`, video_views: 0 }] };
test('exact handles, bounded real media, zero and unknown metrics, expiry and safe links', () => {
    assert.equal(ttoHandle('https://www.tiktok.com/@Trevonbassmaster/'), 'trevonbassmaster');
    for (const value of ['https://evil.test/@trevonbassmaster', 'https://tiktok.com/@trevonbassmaster/video/123', '@other/person', 'https://tiktok.com/@trevonbassmaster?tracking=1'])
        assert.equal(ttoHandle(value), null);
    for (const value of ['javascript:alert(1)', 'http://p16.tiktokcdn.com/x', 'https://tiktokcdn.com.evil.test/a', 'https://secret@tiktokcdn.com/a'])
        assert.equal(ttoImage(value), null);
    const report = parseTtoReport('trevonbassmaster', profile, { posts: [...media.posts, ...media.posts] }, now);
    assert.equal(report.videos.length, 1);
    assert.equal(report.followers, 0);
    assert.equal(report.medianViews, null);
    assert.equal(report.videos[0]?.views, 0);
    assert.equal(report.videos[0]?.likes, null);
    assert.equal(report.videos[0]?.url, 'https://www.tiktok.com/@trevonbassmaster/video/123456789');
    assert.equal(report.videos[0]?.createdAt, new Date(+now - 10000).toISOString());
    assert.equal(readTtoReport(report, new Date(+now + 61000))?.videos[0]?.thumbnailUrl, null);
    assert.throws(() => parseTtoReport('hopeholcer', profile, media, now), /IDENTITY_MISMATCH/);
    assert.throws(() => parseTtoReport('trevonbassmaster', profile, {}, now), /INVALID_RESPONSE/);
    assert.equal(parseTtoReport('trevonbassmaster', profile, { posts: [] }, now).videos.length, 0);
});
test('public API authenticates server-side, bounds pages, and sanitizes failures', async () => {
    const calls: {
        url: string;
        init: RequestInit;
    }[] = [];
    const api = new TtoPublicApi({ appId: '12345', secret: 'not-real-secret' }, async (url, init) => {
        calls.push({ url: String(url), init: init! });
        const data = String(url).includes('/oauth2/') ? { tto_tcm_account_ids: ['12345'] } : String(url).includes('/video/list/') ? media : profile;
        return Response.json({ code: 0, data });
    });
    assert.deepEqual(await api.accounts('not-real-token'), ['12345']);
    await api.report('not-real-token', '12345', 'trevonbassmaster', now);
    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.init.redirect, 'error');
    assert.equal(calls[0]?.init.headers && new Headers(calls[0].init.headers).get('Access-Token'), 'not-real-token');
    const video = new URL(calls[2]!.url);
    assert.equal(video.searchParams.get('limit'), '25');
    assert.equal(video.searchParams.get('cursor'), '0');
    for (const [status, code] of [[429, 'RATE_LIMITED'], [403, 'PERMISSION_REQUIRED'], [503, 'UNAVAILABLE']] as const) {
        const failed = new TtoPublicApi({ appId: '12345', secret: 'secret' }, async () => new Response('private provider text', { status }));
        await assert.rejects(failed.accounts('secret-token'), { message: code });
    }
});
test('service does not publish after source revocation; fails closed and keeps errors private', async () => {
    const p = { organizationId: 'org', userId: 'admin', sessionId: 'session' };
    let sealed: Buffer | null = null;
    const key = Buffer.alloc(32, 7);
    const authRepo = { consume: async () => true, store: async (_p: unknown, _k: unknown, _s: unknown, g: {
            tokenSealed: Buffer;
        }) => { sealed = g.tokenSealed; return true; } };
    const service = new TikTokBusinessService(authRepo as never, { key, authorizationUrl: 'https://business-api.tiktok.com/portal/auth?app_id=12345', redirectUri: 'https://app.emgloop.com/api/integrations/tiktok-business/callback', exchange: async () => ({ accessToken: 'test-token', refreshToken: null, openId: null, expiresIn: null, refreshExpiresIn: null }) });
    // The production service creates the exact authenticated ciphertext used by the importer.
    await service.complete(p, 'TTO', { state: 'a'.repeat(64), authCode: 'code', error: null });
    let published = 0;
    let failure = '';
    const repository = { authorizedProfile: async () => ({ id: 'creator' }), claim: async () => ({ organizationId: 'org', profileId: 'creator', handle: 'trevonbassmaster', leaseId: 'lease', source: { id: 'grant', userId: 'admin', revision: 1, tokenSealed: sealed, ttoAccountId: '12345', importEnabled: true } }), publish: async () => { published++; return false; }, failure: async (_claim: unknown, code: string) => { failure = code; } };
    const importService = new TtoMediaService(repository as unknown as TtoMediaRepository, { key, api: { accounts: async () => ['12345'], report: async () => parseTtoReport('trevonbassmaster', profile, media, now) } });
    assert.equal(await importService.refresh(p, 'creator', true), 'WITHDRAWN');
    assert.equal(published, 1);
    assert.equal(failure, 'WITHDRAWN');
    repository.authorizedProfile = async () => null as never;
    assert.equal(await importService.refresh(p, 'someone-else', true), 'NOT_PERMITTED');
    assert.equal(published, 1);
});

test('audience fractions survive persistence without inventing missing groups or mixing populations',()=>{
 const report=parseTtoReport('trevonbassmaster',{...profile,audience_ages:[{age:'25-34',percentage:0.6}],audience_genders:[{gender:'Female',percentage:0.4},{gender:'Male',percentage:0.6}],audience_countries:[{country:'US',percentage:0.9}],reached_audience_genders:[{gender:'Female',percentage:0.7}],engaged_audience_ages:[{age:'18-24',percentage:0.5}]},media,now);
 const saved=readTtoReport(JSON.parse(JSON.stringify(report)),now)!;
 assert.equal(saved.audience?.followers.ages[0]?.percentage,0.6);
 assert.equal(saved.audience?.reached.genders[0]?.percentage,0.7);
 assert.equal(saved.audience?.engaged.ages[0]?.label,'18-24');
 assert.deepEqual(saved.audience?.engaged.countries,[]);
 const invalid=parseTtoReport('trevonbassmaster',{...profile,audience_genders:[{gender:'Female',percentage:70}],audience_ages:[{age:'25-34',percentage:0.8},{age:'35-44',percentage:0.8}]},media,now);
 assert.deepEqual(invalid.audience?.followers.genders,[]);
 assert.deepEqual(invalid.audience?.followers.ages,[]);
});
test('history resumes after the newest page, deduplicates boundaries, refreshes leaders, and preserves more than 25 videos',async()=>{
 const cursors:string[]=[];
 const posts=(start:number,n:number)=>Array.from({length:n},(_,i)=>({video_id:String(100000+start+i),caption:'Post',create_time:String(+now-(start+i)*1000),video_views:start+i}));
 const api=new TtoPublicApi({appId:'12345',secret:'fake'},async(url)=>{
  const u=new URL(String(url)); if(!u.pathname.includes('/video/list/'))return Response.json({code:0,data:profile});
  const cursor=u.searchParams.get('cursor'); const ids=u.searchParams.get('video_ids');
  if(ids)return Response.json({code:0,data:{posts:(JSON.parse(ids) as string[]).map(id=>({video_id:id,video_views:999,create_time:String(+now-99999)}))}});
  cursors.push(cursor!);
  return Response.json({code:0,data:{posts:cursor==='0'?posts(0,25):posts(24,8),page_info:{has_more:cursor==='0',cursor:cursor==='0'?123456:123400}}});
 });
 const first=await api.report('fake','12345','trevonbassmaster',now);
 assert.equal(first.history?.cursor,'123456');assert.equal(first.history?.complete,false);
 const second=await api.report('fake','12345','trevonbassmaster',now,readTtoReport(first,now));
 assert.deepEqual(cursors,['0','0','123456']);assert.equal(second.videos.length,32);assert.equal(second.history?.complete,true);
 assert.equal(readTtoReport(second,now)?.videos.length,32);
 const stalled=new TtoPublicApi({appId:'12345',secret:'fake'},async(url)=>Response.json({code:0,data:String(url).includes('/video/list/')?{posts:[],page_info:{has_more:true,cursor:123456}}:profile}));
 await assert.rejects(stalled.report('fake','12345','trevonbassmaster',now,first),/INVALID_RESPONSE/);
});

test('persisted historical evidence survives beyond the former 500-video boundary',()=>{
 const report=parseTtoReport('trevonbassmaster',profile,{posts:[]},now);
 const base=parseTtoReport('trevonbassmaster',profile,media,now).videos[0]!;
 report.videos=Array.from({length:601},(_,i)=>({...base,id:String(100000+i),url:`https://www.tiktok.com/@trevonbassmaster/video/${100000+i}`}));
 report.history={cursor:'123456',complete:false,capped:false};
 const saved=readTtoReport(JSON.parse(JSON.stringify(report)),now)!;
 assert.equal(saved.videos.length,601);assert.equal(saved.videos[500]?.id,'100500');assert.equal(saved.history?.cursor,'123456');
});
