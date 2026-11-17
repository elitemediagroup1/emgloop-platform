import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CreatorAnalyticsCoach } from '../../../../creator/creator-analytics-coach';
import { creatorAnalyticsReviewRepository, creatorAnalyticsReviewService, creatorAnalyticsReviewActive } from '../../../../creator/creator-analytics-coach-runtime';
import { MetaAnalyticsPanel } from '../../../../meta/meta-panels';
import { YouTubeAnalyticsPanel } from '../../../../youtube/youtube-panel';
import { requireWorkspace } from '../../../../workspaces/guard';
import { CREATOR_HREFS, creatorDomain, requireCreator } from '../../../../creator/creator-runtime';
import { CreatorPageHead } from '../../../../creator/creator-page-head';
import { refreshCreatorAnalyticsAction } from '../../../../creator/creator-analytics-coach-action';
import { connectedTikTokOverview } from '../../../../creator/creator-tiktok-overview';
import { videoHistorySets } from '../../../../creator/creator-video-history';
import { performanceSample } from '../../../../creator/creator-performance-insights';
import { featuredPostFeedback } from '../../../../creator/creator-featured-feedback';
import { tiktok } from '../../../../tiktok/tiktok-runtime';
import { tiktokSocialAccountOf } from '@emgloop/shared';
import { readTikTokEntry } from '../_parts/tiktok-connection';
import { CreatorConnectedTikTokAnalytics, selectTikTokAnalyticsSource } from '../../../../creator/creator-connected-tiktok-analytics';
import { CreatorTikTokAnalytics } from '../../../../creator/creator-tiktok-analytics';
import { ttoMediaRepository } from '../../../../tiktok-business/runtime';
import { viewerTime } from '../../../../time/viewer-time';
import { settle } from '../../_home/settle';
import { LoopPage, Panel, StateBlock } from '../../_loop-os/record';
import { param } from '../_parts/vocabulary';
export const dynamic = 'force-dynamic';
const PLATFORMS = [
  { id: 'TIKTOK', label: 'TikTok' },
  { id: 'INSTAGRAM', label: 'Instagram' },
  { id: 'YOUTUBE', label: 'YouTube' },
  { id: 'FACEBOOK', label: 'Facebook' },
] as const;
export default async function CreatorAnalyticsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const time = viewerTime(),
    principal = {
      organizationId: seat.actor.organizationId,
      userId: seat.actor.userId,
      creatorProfileId: seat.profileId,
    };
  const raw = param(searchParams.platform);
  const platform = PLATFORMS.find((p) => p.id === raw)?.id ?? 'TIKTOK';
  if (platform === 'TIKTOK' && searchParams.source) redirect(`${CREATOR_HREFS.analytics}?platform=TIKTOK`);
  const accountRead = platform === 'TIKTOK' ? await settle(() => tiktok().readOnVisit(principal)) : null;
  const accountStatus = platform === 'TIKTOK' ? await settle(() => tiktok().status(principal)) : null;
  const status = accountStatus?.ok && accountStatus.value.permitted ? accountStatus.value.state : null;
  const source = selectTikTokAnalyticsSource(null, status);
  const accountProfile = platform === 'TIKTOK' && source === 'ACCOUNT'
    ? await settle(() => creatorDomain().creator.profileById(seat.actor.organizationId, seat.profileId)) : null;
  const accountEntry = accountProfile?.ok ? readTikTokEntry(tiktokSocialAccountOf(accountProfile.value?.socialAccounts)) : null;
  const publicReport =
    platform === 'TIKTOK'
      ? await settle(() => ttoMediaRepository().read(principal, seat.profileId, time.now))
      : null;
  let coach = platform === 'TIKTOK' ? await settle(() => creatorAnalyticsReviewRepository().current(principal, source, time.now)) : null;
  let coachOutcome: string | null = null;
  if (platform === 'TIKTOK' && coach?.ok && !coach.value && creatorAnalyticsReviewActive(principal.organizationId)) {
    // Existing per-creator leases, fingerprint cache, retry backoff and daily budgets fence this call.
    const result = await settle(() => creatorAnalyticsReviewService().review(principal, source));
    coachOutcome = result.ok ? result.value : 'UNAVAILABLE';
    if (coachOutcome === 'ANALYZED' || coachOutcome === 'NOT_DUE') coach = await settle(() => creatorAnalyticsReviewRepository().current(principal, source, time.now));
  }
  const reviewStatus=platform==='TIKTOK'?await settle(()=>creatorAnalyticsReviewRepository().status(principal,source,time.now)):null;
  let earlier=false;
  if(platform==='TIKTOK'&&coach?.ok&&!coach.value){const previous=await settle(()=>creatorAnalyticsReviewRepository().previous(principal,source,time.now));if(previous.ok&&previous.value){coach=previous;earlier=true;}}
  const videos = source === 'ACCOUNT' && accountEntry
    ? connectedTikTokOverview(accountEntry, publicReport?.ok ? publicReport.value : null).videos
    : publicReport?.ok ? (publicReport.value?.report?.videos ?? []).map(v => ({ id:v.id,title:v.caption,url:v.url,views:v.views,likes:v.likes,comments:v.comments,shares:v.shares,thumbnail:v.thumbnailUrl,publishedAt:v.createdAt })) : [];
  const feedback = featuredPostFeedback(coach?.ok ? coach.value : null, performanceSample(videoHistorySets(videos).recent).ranked[0]?.id);
  return (
    <LoopPage label="Analytics">
      <CreatorPageHead
        section="Analytics"
        title="Know what is working."
        description=""
        actions={
          <>
            {platform === 'TIKTOK' ? <form action={refreshCreatorAnalyticsAction}><button className="loop-btn loop-btn--primary" type="submit">Refresh insights</button></form> : <Link className="loop-btn" href={CREATOR_HREFS.profile}>Manage connections →</Link>}
          </>
        }
      />
      <nav className="ch-analytics-tabs" aria-label="Analytics platform">
        {PLATFORMS.map((p) => (
          <Link
            key={p.id}
            className="ch-analytics-tab"
            href={`${CREATOR_HREFS.analytics}?platform=${p.id}`}
            aria-current={platform === p.id ? 'page' : undefined}
          >
            {p.label}
          </Link>
        ))}
      </nav>
      {platform === 'TIKTOK' ? <CreatorAnalyticsCoach review={coach?.ok ? coach.value : null} source={source} time={time} outcome={coachOutcome} status={reviewStatus?.ok?reviewStatus.value:null} earlier={earlier}/> : null}
      {platform === 'TIKTOK' ? (
        source === 'ACCOUNT' ? <CreatorConnectedTikTokAnalytics feedback={feedback} entry={accountEntry} publicReport={publicReport?.ok ? publicReport.value : null} state={status} readFailed={param(searchParams.tiktok_sync) === 'FAILED' || !accountRead?.ok || !accountRead.value.ok || !accountProfile?.ok} time={time} /> :
        publicReport?.ok && publicReport.value?.report ? (
          <>
            <CreatorTikTokAnalytics
              feedback={feedback}
              report={publicReport.value.report}
              updatedAt={publicReport.value.lastReadAt}
              stale={publicReport.value.stale}
              time={time}
            />
          </>
        ) : (
          <Panel title="TikTok">
            <StateBlock
              kind={publicReport?.ok ? 'empty' : 'error'}
              compact
              title={
                publicReport?.ok ? 'No current TikTok data.' : 'TikTok report could not be loaded.'
              }
              body="Add your TikTok handle or connect your account on Profile, then refresh your insights."
            />
            <Link className="loop-btn" href={CREATOR_HREFS.profile}>Manage your TikTok account →</Link>
          </Panel>
        )
      ) : platform === 'YOUTUBE' ? (
        <YouTubeAnalyticsPanel
          principal={principal}
          syncOutcome={param(searchParams.youtube_sync) ?? undefined}
        />
      ) : (
        <MetaAnalyticsPanel
          principal={principal}
          platform={platform}
          outcome={param(searchParams.meta) ?? undefined}
        />
      )}
      <p className="loop-note ch-report-foot">
        Reporting periods and available metrics differ by platform. Unreported values stay empty;
        historical observations are not presented as current reports.
      </p>
    </LoopPage>
  );
}
