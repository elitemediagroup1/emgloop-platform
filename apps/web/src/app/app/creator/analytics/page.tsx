import { MetaAnalyticsPanel } from '../../../../meta/meta-panels';
import { YouTubeAnalyticsPanel } from '../../../../youtube/youtube-panel';
import Link from 'next/link';
import { EVIDENCE_SOURCE_LABELS, type EvidenceSource, SOCIAL_PLATFORM_LABELS } from '@emgloop/shared';
import { requireWorkspace } from '../../../../workspaces/guard';
import { CREATOR_HREFS, creatorDomain, requireCreator } from '../../../../creator/creator-runtime';
import { ObservedTikTokReport } from '../../../../creator/observed-tiktok-report';
import { loadAnalytics } from '../../../../creator/creator-data';
import { viewerTime } from '../../../../time/viewer-time';
import { LoopPage, PageHead, Panel, StateBlock, SummaryStrip } from '../../_loop-os/record';
import { AudienceChart, groupAudience } from '../_parts/audience-chart';
import { compactNumber, param } from '../_parts/vocabulary';

export const dynamic = 'force-dynamic';

const WINDOWS = [7, 30, 90] as const;
const PLATFORM_TABS = [
  { id: 'INSTAGRAM', label: 'Instagram' },
  { id: 'TIKTOK', label: 'TikTok' },
  { id: 'YOUTUBE', label: 'YouTube' },
  { id: 'FACEBOOK', label: 'Facebook' },
] as const;

export default async function CreatorAnalyticsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const time = viewerTime();
  const daysRaw = Number(param(searchParams.days) ?? 30);
  const days = (WINDOWS as readonly number[]).includes(daysRaw) ? daysRaw : 30;
  const platformRaw = param(searchParams.platform);
  const platform = PLATFORM_TABS.some(item => item.id === platformRaw) ? platformRaw as typeof PLATFORM_TABS[number]['id'] : null;
  const profile = await creatorDomain().creator.profileById(seat.actor.organizationId, seat.profileId);
  const all = await loadAnalytics(seat, { days });
  const href = (selected: string | null, windowDays: number) => {
    const query = [selected ? 'platform=' + selected : null, 'days=' + windowDays].filter(Boolean).join('&');
    return CREATOR_HREFS.analytics + (query ? '?' + query : '');
  };
  const hasOverviewTotals = all.totals.views !== null || all.totals.reach !== null || all.totals.engagements !== null;
  const hasOverviewDetails = all.performance.length > 0 || all.audience.length > 0 || all.topContent.length > 0;

  return (
    <LoopPage label="Analytics">
      <PageHead trail={[{ label: 'Creator' }, { label: 'Analytics' }]} title="Analytics" subtitle="Choose a platform to see its performance and audience." />

      <nav className="ch-analytics-tabs" aria-label="Analytics platform">
        <Link className="ch-analytics-tab" href={href(null, days)} aria-current={platform === null ? 'page' : undefined}>Overview</Link>
        {PLATFORM_TABS.map(item => (
          <Link key={item.id} className="ch-analytics-tab" href={href(item.id, days)} aria-current={platform === item.id ? 'page' : undefined}>
            {item.label}
          </Link>
        ))}
      </nav>

      {platform === 'YOUTUBE' ? (
        <YouTubeAnalyticsPanel principal={{ organizationId: seat.actor.organizationId, userId: seat.actor.userId }} syncOutcome={param(searchParams.youtube_sync) ?? undefined} />
      ) : platform === 'FACEBOOK' || platform === 'INSTAGRAM' ? (
        <MetaAnalyticsPanel principal={{ organizationId: seat.actor.organizationId, userId: seat.actor.userId, creatorProfileId: seat.profileId }} outcome={param(searchParams.meta) ?? undefined} platform={platform} />
      ) : platform === 'TIKTOK' ? (
        <ObservedTikTokReport preferences={profile?.preferences} time={time} showEmpty />
      ) : (
        <>
          {all.seeded ? <StateBlock kind="attention" compact title="Demo data" body="Some figures are examples and are not real platform results." /> : null}
          <div className="ch-analytics-overview">
            <div className="ch-analytics-overview__intro">
              <div>
                <span className="ch-analytics-eyebrow">Overview</span>
                <h2>Across your platforms</h2>
              </div>
              <nav className="ch-analytics-window" aria-label="Reporting window">
                {WINDOWS.map(windowDays => (
                  <Link key={windowDays} href={href(null, windowDays)} aria-current={days === windowDays ? 'page' : undefined}>{windowDays} days</Link>
                ))}
              </nav>
            </div>
            {hasOverviewTotals ? (
              <SummaryStrip
                label="Reported performance"
                items={[
                  { label: 'Views', value: all.totals.views === null ? null : compactNumber(all.totals.views), unknownText: 'Not reported' },
                  { label: 'Reach', value: all.totals.reach === null ? null : compactNumber(all.totals.reach), unknownText: 'Not reported' },
                  { label: 'Engagements', value: all.totals.engagements === null ? null : compactNumber(all.totals.engagements), unknownText: 'Not reported' },
                ]}
              />
            ) : null}
            {hasOverviewDetails ? (
              <div className="ch-analytics-overview__grid">
                {all.audience.length ? (
                  <Panel title="Audience growth">
                    <div className="ch-charts">
                      {groupAudience(all.audience).map(series => <AudienceChart key={series.platform} series={series} time={time} />)}
                    </div>
                  </Panel>
                ) : null}
                {all.topContent.length ? (
                  <Panel title="Top content">
                    <ol className="ch-list" aria-label="Top content by views">
                      {all.topContent.map(item => (
                        <li key={item.contentId}>
                          <Link className="ch-row" href={CREATOR_HREFS.contentRecord(item.contentId)}>
                            <span className="ch-row__main">
                              <span className="ch-row__title">{item.title}</span>
                              <span className="ch-row__meta">{(SOCIAL_PLATFORM_LABELS as Record<string, string>)[item.platform] ?? item.platform}</span>
                            </span>
                            <span className="ch-row__amount">{compactNumber(item.views)} views</span>
                          </Link>
                        </li>
                      ))}
                    </ol>
                  </Panel>
                ) : null}
              </div>
            ) : (
              <div className="ch-analytics-empty">
                <p>No reporting-window analytics to show yet.</p>
                <span>Open a platform above for its latest snapshot, or <Link href={CREATOR_HREFS.profile}>manage your connections</Link>.</span>
              </div>
            )}
            {hasOverviewDetails ? (
              <p className="ch-analytics-source">
                {all.performance.length} report{all.performance.length === 1 ? '' : 's'} in this window
                {all.sources.length ? ' · ' + all.sources.map(source => EVIDENCE_SOURCE_LABELS[source as EvidenceSource] ?? source).join(', ') : ''}
              </p>
            ) : null}
            {!all.connected ? <p className="ch-analytics-source"><Link href={CREATOR_HREFS.profile}>Connect your social accounts</Link> to start collecting platform analytics.</p> : null}
          </div>
        </>
      )}
    </LoopPage>
  );
}
