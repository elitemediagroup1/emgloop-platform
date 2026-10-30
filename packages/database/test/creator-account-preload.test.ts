import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { CreatorRepository } from '../src/creator/creator.repository';
import { IamRepository } from '../src/repositories/iam.repository';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
const input = { handles: { TIKTOK: 'https://www.tiktok.com/@testcreator', YOUTUBE: 'https://www.youtube.com/@testcreator', INSTAGRAM: 'https://www.instagram.com/testcreator/' }, mailboxEmail: 'Test@Example.test', followers: { TIKTOK: '176.9K', YOUTUBE: '6.97K', INSTAGRAM: '19,267' }, tiktokOneUrl: 'https://ads.tiktok.com/creative/creator/profile/1234', medianViews: '942', engagementPct: '5.50', view6sPct: '44.23' };
async function world() {
 const db = makeCognitivePrisma({ also: ['creatorProfile','creatorAudienceSnapshot','organizationMembership'] }) as unknown as PrismaClient;
 const iam = new IamRepository(db); const repo = new CreatorRepository(db);
 const owner = await iam.createUser({organizationId:'a',email:'owner@example.test',systemRole:'OWNER'}); await iam.activateUser('a',owner.id);
 const creator = await iam.createUser({organizationId:'a',email:'creator@example.test',systemRole:'CREATOR'}); await iam.activateUser('a',creator.id);
 const profile = await repo.createProfile({organizationId:'a',partyId:'p',displayName:'Test',preferences:{notifyOnReturn:true}});
 return {db,iam,repo,owner,creator,profile};
}
test('preload keeps references, rounded provenance and sampled metrics separate from connected APIs',async()=>{
 const w=await world(); assert.equal(await w.repo.preloadAccounts('a',w.owner.id,w.profile.id,input),'SAVED');
 const p=await w.repo.profileById('a',w.profile.id); const prefs=p!.preferences as unknown as { managedMailboxEmail: string; notifyOnReturn: boolean; socialObservations: Record<string,{displayed:string;rounded:boolean}>; tiktokOneObservation: {basis:string;engagementPct:number} };
 assert.equal(prefs.managedMailboxEmail,'test@example.test'); assert.equal(prefs.notifyOnReturn,true);
 assert.equal(prefs.socialObservations.TIKTOK!.displayed,'176.9K'); assert.equal(prefs.socialObservations.TIKTOK!.rounded,true);
 assert.equal(prefs.socialObservations.INSTAGRAM!.rounded,false); assert.equal(prefs.tiktokOneObservation.basis,'30 most recent videos');
 assert.equal(prefs.tiktokOneObservation.engagementPct,5.5); assert.deepEqual(p?.socialAccounts,[]);
 const rows=await w.repo.listAudience('a',w.profile.id); assert.equal(rows.length,3); assert.equal(rows.find(r=>r.platform==='INSTAGRAM')?.followers,19267);
 assert.equal(rows.find(r=>r.platform==='TIKTOK')?.source,'TIKTOK_ONE_MANUAL'); assert.ok(rows.every(r=>r.growth30dPct===null));
 assert.equal(await w.db.auditLog.count({where:{action:'creator.accounts.preloaded'}}),1);
});
test('unavailable counts stay absent; reference-only save does not invent or refresh analytics',async()=>{
 const w=await world(); await w.repo.preloadAccounts('a',w.owner.id,w.profile.id,{...input,followers:{},tiktokOneUrl:'',medianViews:'',engagementPct:'',view6sPct:''});
 assert.equal(await w.db.creatorAudienceSnapshot.count(),0);
 const p=await w.repo.profileById('a',w.profile.id); assert.equal((p!.preferences as Record<string,unknown>).tiktokOneObservation,undefined);
});
test('creator, tenant mismatch, invalid sources/counts/percentages are refused without writes',async()=>{
 const w=await world();
 assert.equal(await w.repo.preloadAccounts('a',w.creator.id,w.profile.id,input),'NOT_ALLOWED');
 const foreign=await w.repo.createProfile({organizationId:'b',partyId:'q',displayName:'Other'});
 assert.equal(await w.repo.preloadAccounts('a',w.owner.id,foreign.id,input),'NOT_FOUND');
 for(const bad of [{followers:{TIKTOK:'unknown'}},{followers:{TIKTOK:'2147483648'}},{engagementPct:'101'},{tiktokOneUrl:'https://evil.test/profile/1234'},{mailboxEmail:'not-an-email'}]) assert.equal(await w.repo.preloadAccounts('a',w.owner.id,w.profile.id,{...input,...bad}),'INVALID');
 assert.equal(await w.db.creatorAudienceSnapshot.count(),0); assert.equal(await w.db.auditLog.count(),0);
});
