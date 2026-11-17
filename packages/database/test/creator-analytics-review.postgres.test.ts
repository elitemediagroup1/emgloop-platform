import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type { AiDomainReading } from '@emgloop/shared';
import { IamRepository } from '../src/repositories/iam.repository';
import { CreatorAnalyticsReviewRepository } from '../src/creator/creator-analytics-review.repository';
const url=process.env.LOOP_TEST_POSTGRES_URL??'';
const local=/^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
test('Postgres: coaching leases, creator isolation, source change and revocation fences', {skip:local?false:'Disposable localhost Postgres required'},async()=>{
 const db=new PrismaClient({datasources:{db:{url}}}),org=`coach_${randomUUID()}`,other=`coach_${randomUUID()}`;
 try{
  await db.organization.createMany({data:[{id:org,name:'A',slug:org},{id:other,name:'B',slug:other}]});
  const iam=new IamRepository(db),repo=new CreatorAnalyticsReviewRepository(db);
  const user=await iam.createUser({organizationId:org,email:'coach@example.test',systemRole:'CREATOR'});await iam.activateUser(org,user.id);
  const now=new Date(),p={organizationId:org,userId:user.id};
  const entry={platform:'TIKTOK',state:'CONNECTED',handle:'example',readAt:now.toISOString(),stats:{followers:100},recentVideos:[{id:'a',title:'A post',viewCount:100,likeCount:2},{id:'b',title:'Another post',viewCount:30,likeCount:0}]};
  const profile=await db.creatorProfile.create({data:{organizationId:org,userId:user.id,partyId:'coach-party',displayName:'Creator',socialAccounts:[entry]}});
  await db.tikTokConnection.create({data:{organizationId:org,userId:user.id,tiktokOpenId:'scoped-account',status:'CONNECTED',connectedAt:now,refreshTokenSealed:Buffer.from('test-only')}});
  assert.equal(await repo.snapshot({...p,organizationId:other},'ACCOUNT',now),null);
  const attempts=await Promise.allSettled([repo.claim(p,'ACCOUNT',now),repo.claim(p,'ACCOUNT',now)]);
  const claims=attempts.flatMap(r=>r.status==='fulfilled'&&r.value?[r.value]:[]);assert.equal(claims.length,1);
  const claim=claims[0]!;
  const reading={reading:{statement:'A bounded review',status:'QUIET',confidence:'LOW'},signals:[],limitations:['No video was watched.']} as unknown as AiDomainReading;
  assert.equal(await repo.finish(p,claim,now,{reading,invocationId:'test-invocation',providerId:'openai'}),true);
  assert.ok(await repo.current(p,'ACCOUNT',now));
  assert.equal(await repo.current({...p,userId:'another-user'},'ACCOUNT',now),null);
  assert.equal(await repo.claim(p,'ACCOUNT',now),null,'unchanged report is never regenerated');
  await db.creatorProfile.update({where:{id:profile.id},data:{socialAccounts:[{...entry,stats:{followers:101}}]}});
  assert.equal(await repo.current(p,'ACCOUNT',now),null,'old evidence cannot appear current');
  assert.equal(await repo.claim(p,'ACCOUNT',now),null,'new evidence does not bypass the spend cooldown');
  const later=new Date(+now+901000),next=await repo.claim(p,'ACCOUNT',later);assert.ok(next);
  await db.tikTokConnection.updateMany({where:p,data:{status:'REVOKED',refreshTokenSealed:null}});
  assert.equal(await repo.finish(p,next,later,{reading,invocationId:'test-revoked',providerId:'openai'}),false);
  assert.equal(await repo.current(p,'ACCOUNT',later),null,'disconnect withdraws published data immediately');
 }finally{await db.organization.deleteMany({where:{id:{in:[org,other]}}});await db.$disconnect();}
});
