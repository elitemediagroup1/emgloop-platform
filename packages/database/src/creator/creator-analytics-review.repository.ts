import { randomUUID, createHash } from 'crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { tiktokSocialAccountOf, type AiDomainReading } from '@emgloop/shared';
import { readTtoReport } from '@emgloop/providers';
import { membershipAuthority } from '../repositories/membership.repository';
import { profileTtoHandle, ttoOwnerAuthorized } from '../repositories/tto-media.repository';
import { absentUntilMigrated } from './until-migrated';
import { reviewFingerprint, type AnalyticsSource, type AnalyticsReviewEvidence } from './creator-analytics-review';
type Principal = { organizationId: string; userId: string };
type Db = PrismaClient | Prisma.TransactionClient;
const obj = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
const text = (x: unknown) => typeof x === 'string' ? x : null;
const key = (x: string) => createHash('sha256').update(x).digest('hex').slice(0,24);
export class CreatorAnalyticsReviewRepository {
  constructor(private readonly db: PrismaClient) {}
  private async snapshotIn(db: Db, p: Principal, source: AnalyticsSource, now: Date): Promise<{profileId:string;evidence:AnalyticsReviewEvidence;fingerprint:string;observedAt:Date}|null> {
    const member = await membershipAuthority(db, p.organizationId, p.userId, now);
    if (!member.granted || member.systemRole !== 'CREATOR') return null;
    const profile = await db.creatorProfile.findFirst({ where: { organizationId: p.organizationId, userId: p.userId } });
    if (!profile) return null;
    let evidence: AnalyticsReviewEvidence;
    let observedAt=now;
    if (source === 'ACCOUNT') {
      const connection = await db.tikTokConnection.findFirst({ where: { organizationId: p.organizationId, userId: p.userId, status: 'CONNECTED', refreshTokenSealed: { not: null } }, select: { id: true, tiktokOpenId: true, connectedAt: true } });
      const entry = tiktokSocialAccountOf(profile.socialAccounts), stats = obj(entry?.stats);
      if (!connection || entry?.state !== 'CONNECTED' || typeof entry.readAt !== 'string' || !Number.isFinite(Date.parse(entry.readAt)) || +now - Date.parse(entry.readAt) > 86400000) return null;
      observedAt=new Date(entry.readAt);
      const posts = (Array.isArray(entry.recentVideos) ? entry.recentVideos : []).slice(0,10).map(obj);
      evidence = { source, identity: key(`${connection.id}:${connection.tiktokOpenId}:${connection.connectedAt.toISOString()}`), account: { followers: num(stats.followers), likes: num(stats.likes), videos: num(stats.videos), medianViews: null }, posts: posts.map(post => ({ key: key(String(post.id)), caption: (text(post.title) ?? '').slice(0,500), publishedAt: text(post.createdAt), views: num(post.viewCount), likes: num(post.likeCount), comments: null, shares: null, url: typeof post.shareUrl === 'string' && /^https:\/\/(www\.)?tiktok\.com\//.test(post.shareUrl) ? post.shareUrl : null })) };
      const ownHandle=text(entry.handle)?.trim().replace(/^@/,'').toLowerCase();
      if(ownHandle && ownHandle===profileTtoHandle(profile.preferences)) {
        const supplement=await this.snapshotIn(db,p,'TIKTOK_ONE',now);
        if(supplement){
          const newer=supplement.observedAt>observedAt;
          evidence.account.medianViews=supplement.evidence.account.medianViews;
          evidence.account.followers=newer?(supplement.evidence.account.followers??evidence.account.followers):(evidence.account.followers??supplement.evidence.account.followers);
          const posts=new Map(evidence.posts.map(post=>[post.key,post]));
          for(const post of supplement.evidence.posts){
            const own=posts.get(post.key);
            posts.set(post.key,own?{...own,url:own.url??post.url,caption:newer?(post.caption||own.caption):(own.caption||post.caption),views:newer?(post.views??own.views):(own.views??post.views),likes:newer?(post.likes??own.likes):(own.likes??post.likes),comments:post.comments,shares:post.shares}:post);
          }
          evidence.posts=[...posts.values()].sort((a,b)=>(Date.parse(b.publishedAt??'')||0)-(Date.parse(a.publishedAt??'')||0)).slice(0,10);
          evidence.identity=key(`${evidence.identity}:${supplement.evidence.identity}`);
        }
      }
    } else {
      const row = await db.ttoCreatorSnapshot.findFirst({ where: { organizationId: p.organizationId, creatorProfileId: profile.id }, include: { connection: true } });
      const c = row?.connection;
      if (!row || !c || row.handle !== profileTtoHandle(profile.preferences) || !c.importEnabled || c.status !== 'CONNECTED' || !c.tokenSealed || c.revision !== row.sourceRevision || !await ttoOwnerAuthorized(db, { organizationId: p.organizationId, userId: c.userId }) || !row.lastReadAt || +now - +row.lastReadAt > 86400000) return null;
      const others = await db.creatorProfile.findMany({ where: { organizationId: p.organizationId, id: { not: profile.id } }, select: { preferences: true } });
      if (others.some(other => profileTtoHandle(other.preferences) === row.handle)) return null;
      observedAt=row.lastReadAt;
      const report = readTtoReport(row.report, now);
      if (!report || report.handle !== row.handle) return null;
      evidence = { source, identity: key(`${c.id}:${c.revision}:${report.creatorId}:${report.handle}`), account: { followers: report.followers, likes: null, videos: null, medianViews: report.medianViews }, posts: report.videos.slice(0,10).map(post => ({ key: key(post.id), caption: post.caption.slice(0,500), publishedAt: post.createdAt, views: post.views, likes: post.likes, comments: post.comments, shares: post.shares, url: post.url })) };
    }
    if (evidence.posts.filter(post => post.views !== null).length < 2) return null;
    return { profileId: profile.id, evidence, fingerprint: reviewFingerprint(evidence), observedAt };
  }
  snapshot(p: Principal, source: AnalyticsSource, now: Date) { return this.snapshotIn(this.db, p, source, now); }
  async current(p: Principal, source: AnalyticsSource, now: Date) {
    const snapshot = await this.snapshot(p, source, now);
    if (!snapshot) return null;
    return absentUntilMigrated(this.db.creatorAnalyticsReview.findFirst({ where: { organizationId:p.organizationId, userId:p.userId, creatorProfileId:snapshot.profileId, source, fingerprint:snapshot.fingerprint, state:'READY', expiresAt:{gt:now} } }));
  }
  async claim(p: Principal, source: AnalyticsSource, now: Date) {
    return this.db.$transaction(async tx => {
      const snapshot = await this.snapshotIn(tx, p, source, now);
      if (!snapshot) return null;
      const scope = { organizationId:p.organizationId,userId:p.userId,creatorProfileId:snapshot.profileId };
      // One review attempt per creator per fifteen minutes, even when source counts change.
      if (await tx.creatorAnalyticsReview.count({where:{...scope,OR:[{leaseUntil:{gt:now}},{nextAttemptAt:{gt:now}}]}})) return null;
      const version = {...scope,source,fingerprint:snapshot.fingerprint};
      const existing = await tx.creatorAnalyticsReview.findFirst({where:version});
      if (existing?.state === 'READY') return null;
      const leaseId=randomUUID(), leaseUntil=new Date(+now+60000),nextAttemptAt=new Date(+now+900000);
      const row=existing ? await tx.creatorAnalyticsReview.update({where:{id:existing.id},data:{leaseId,leaseUntil,nextAttemptAt,state:'PENDING'}}) : await tx.creatorAnalyticsReview.create({data:{...version,evidence:snapshot.evidence as unknown as Prisma.InputJsonValue,leaseId,leaseUntil,nextAttemptAt,expiresAt:new Date(+now+30*86400000)}});
      return {row,snapshot,leaseId};
    },{isolationLevel:'Serializable'});
  }
  async finish(p:Principal, claim:NonNullable<Awaited<ReturnType<CreatorAnalyticsReviewRepository['claim']>>>, now:Date, result:{reading:AiDomainReading;invocationId:string;providerId:string}|{failure:string}) {
    return this.db.$transaction(async tx=>{
      const current=await this.snapshotIn(tx,p,claim.snapshot.evidence.source,now);
      if(!current || current.profileId!==claim.row.creatorProfileId || current.fingerprint!==claim.snapshot.fingerprint) return false;
      const changed=await tx.creatorAnalyticsReview.updateMany({where:{id:claim.row.id,organizationId:p.organizationId,userId:p.userId,creatorProfileId:current.profileId,leaseId:claim.leaseId,leaseUntil:{gt:now}},data:{leaseId:null,leaseUntil:null,...('reading' in result?{state:'READY',reading:result.reading as unknown as Prisma.InputJsonValue,invocationId:result.invocationId,providerId:result.providerId,generatedAt:now,failure:null}:{state:'FAILED',failure:result.failure})}});
      return changed.count===1;
    },{isolationLevel:'Serializable'});
  }
  /** Scheduled maintenance only: expiry-bounded deletion, returns no creator data. */
  async purgeExpired(now:Date){ return absentUntilMigrated(this.db.creatorAnalyticsReview.deleteMany({where:{expiresAt:{lte:now}}})); }
  async purge(p:Principal,now:Date){ return this.db.creatorAnalyticsReview.deleteMany({where:{organizationId:p.organizationId,userId:p.userId,expiresAt:{lte:now}}}); }
}
