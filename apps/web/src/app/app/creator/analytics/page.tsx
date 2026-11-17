import Link from 'next/link';
import { CreatorAnalyticsCoach } from '../../../../creator/creator-analytics-coach';
import { creatorAnalyticsReviewRepository } from '../../../../creator/creator-analytics-coach-runtime';
import { MetaAnalyticsPanel } from '../../../../meta/meta-panels';
import { YouTubeAnalyticsPanel } from '../../../../youtube/youtube-panel';
import { requireWorkspace } from '../../../../workspaces/guard';
import { CREATOR_HREFS, creatorDomain, requireCreator } from '../../../../creator/creator-runtime';
import { CreatorPageHead } from '../../../../creator/creator-page-head';
import { refreshTikTokAnalyticsAction } from '../../../../tiktok/actions';
import { tiktok } from '../../../../tiktok/tiktok-runtime';
import { tiktokSocialAccountOf } from '@emgloop/shared';
import { readTikTokEntry } from '../_parts/tiktok-connection';
import { CreatorConnectedTikTokAnalytics, selectTikTokAnalyticsSource } from '../../../../creator/creator-connected-tiktok-analytics';
import { CreatorTikTokAnalytics } from '../../../../creator/creator-tiktok-analytics';
import { ttoMediaRepository } from '../../../../tiktok-business/runtime';
import { CreatorRefreshButton } from '../../../../creator/CreatorRefreshButton';
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
  const accountRead = platform === 'TIKTOK' ? await settle(() => tiktok().readOnVisit(principal)) : null;
  const accountStatus = platform === 'TIKTOK' ? await settle(() => tiktok().status(principal)) : null;
  const status = accountStatus?.ok && accountStatus.value.permitted ? accountStatus.value.state : null;
  const source = selectTikTokAnalyticsSource(param(searchParams.source), status);
  const accountProfile = platform === 'TIKTOK' && source === 'ACCOUNT'
    ? await settle(() => creatorDomain().creator.profileById(seat.actor.organizationId, seat.profileId)) : null;
  const accountEntry = accountProfile?.ok ? readTikTokEntry(tiktokSocialAccountOf(accountProfile.value?.socialAccounts)) : null;
  const publicReport =
    platform === 'TIKTOK'
      ? await settle(() => ttoMediaRepository().read(principal, seat.profileId, time.now))
      : null;
  const coach = platform === 'TIKTOK' ? await settle(() => creatorAnalyticsReviewRepository().current(principal, source, time.now)) : null;
  return (
    <LoopPage label="Analytics">
      <CreatorPageHead
        section="Analytics"
        title="Know what is working."
        description=""
        actions={
          <>
            <Link className="loop-btn" href={CREATOR_HREFS.profile}>
              Manage connections →
            </Link>
            {platform === 'TIKTOK' ? source === 'ACCOUNT' ? <form action={refreshTikTokAnalyticsAction}><button className="loop-btn" type="submit">Refresh TikTok</button></form> : <CreatorRefreshButton /> : null}
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
      {platform === 'TIKTOK' ? <>
        <nav aria-label="TikTok data source" className="ch-analytics-sources">
          <Link className="ch-analytics-tab" href={`${CREATOR_HREFS.analytics}?platform=TIKTOK&source=ACCOUNT`} aria-current={source === 'ACCOUNT' ? 'page' : undefined}>Account overview</Link>
          <Link className="ch-analytics-tab" href={`${CREATOR_HREFS.analytics}?platform=TIKTOK&source=TIKTOK_ONE`} aria-current={source === 'TIKTOK_ONE' ? 'page' : undefined}>TikTok One report</Link>
        </nav>
        <p className="loop-note">Account overview combines available sources only when their TikTok handles match. Each metric keeps its source.</p>
      </> : null}
      {platform === 'TIKTOK' ? <CreatorAnalyticsCoach review={coach?.ok ? coach.value : null} source={source} time={time} outcome={param(searchParams.coach)} /> : null}
      {platform === 'TIKTOK' ? (
        source === 'ACCOUNT' ? <CreatorConnectedTikTokAnalytics entry={accountEntry} publicReport={publicReport?.ok ? publicReport.value : null} state={status} readFailed={param(searchParams.tiktok_sync) === 'FAILED' || !accountRead?.ok || !accountRead.value.ok || !accountProfile?.ok} time={time} /> :
        publicReport?.ok && publicReport.value?.report ? (
          <>
            <CreatorTikTokAnalytics
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
                publicReport?.ok ? 'No current TikTok One report.' : 'TikTok report could not be loaded.'
              }
              body="EMG’s authorized TikTok One source uses your exact saved handle to fetch eligible public reports. Refresh to request an update."
            />
            <CreatorRefreshButton />
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
