import Link from 'next/link';
import { MetaAnalyticsPanel } from '../../../../meta/meta-panels';
import { YouTubeAnalyticsPanel } from '../../../../youtube/youtube-panel';
import { requireWorkspace } from '../../../../workspaces/guard';
import { CREATOR_HREFS, requireCreator } from '../../../../creator/creator-runtime';
import { CreatorPageHead } from '../../../../creator/creator-page-head';
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
  const tiktok =
    platform === 'TIKTOK'
      ? await settle(() => ttoMediaRepository().read(principal, seat.profileId, time.now))
      : null;
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
            {platform === 'TIKTOK' ? <CreatorRefreshButton /> : null}
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
      {platform === 'TIKTOK' ? (
        tiktok?.ok && tiktok.value?.report ? (
          <>
            <CreatorTikTokAnalytics
              report={tiktok.value.report}
              updatedAt={tiktok.value.lastReadAt}
              stale={tiktok.value.stale}
              time={time}
            />
          </>
        ) : (
          <Panel title="TikTok">
            <StateBlock
              kind={tiktok?.ok ? 'empty' : 'error'}
              compact
              title={
                tiktok?.ok ? 'No current TikTok One report.' : 'TikTok report could not be loaded.'
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
