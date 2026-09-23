import Link from 'next/link';
import { SOCIAL_PLATFORMS, SOCIAL_PLATFORM_LABELS } from '@emgloop/shared';
import { requireWorkspace } from '../../../../workspaces/guard';
import { CREATOR_HREFS, requireCreator } from '../../../../creator/creator-runtime';
import { loadAnalytics } from '../../../../creator/creator-data';
import { viewerTime } from '../../../../time/viewer-time';
import { LoopPage, PageHead, Panel, StateBlock, SummaryStrip } from '../../_loop-os/record';
import { AudienceChart, groupAudience } from '../_parts/audience-chart';
import { compactNumber, param } from '../_parts/vocabulary';

// Analytics (Creator Hub): what the stored evidence says, labelled by where it came from.
//
// No platform is connected today (connections are not built), so every row is either seeded demo
// data -- said so, in a banner and on every point -- or a row EMG recorded. A window with no rows
// shows no number; a creator with nothing at all sees "Not connected", not a zero.
//   ?platform=INSTAGRAM|TIKTOK|...   one platform's rows
//   ?days=7|30|90                    the reporting window (default 30)

export const dynamic = 'force-dynamic';

const WINDOWS = [7, 30, 90] as const;

export default async function CreatorAnalyticsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const time = viewerTime();
  const daysRaw = Number(param(searchParams.days) ?? 30);
  const days = (WINDOWS as readonly number[]).includes(daysRaw) ? daysRaw : 30;
  const platformRaw = param(searchParams.platform);
  const platform = platformRaw && (SOCIAL_PLATFORMS as readonly string[]).includes(platformRaw) ? platformRaw : null;
  const all = await loadAnalytics(seat, { days });
  const view = platform ? await loadAnalytics(seat, { platform, days }) : all;
  const platforms = [...new Set([...all.platforms, ...all.latestAudience.map((a) => a.platform)])];
  const audienceRows = platform ? all.audience.filter((a) => a.platform === platform) : all.audience;
  const latest = platform ? all.latestAudience.filter((a) => a.platform === platform) : all.latestAudience;
  const followers = latest.length > 0 ? latest.reduce((s, a) => s + a.followers, 0) : null;
  const nothing = !all.connected && all.performance.length === 0 && all.audience.length === 0;
  const href = (p: string | null, d: number) => `${CREATOR_HREFS.analytics}?${[p ? `platform=${p}` : null, `days=${d}`].filter(Boolean).join('&')}`;

  return (
    <LoopPage label="Analytics">
      <PageHead trail={[{ label: 'Creator' }, { label: 'Analytics' }]} title="Analytics" subtitle="Reach and audience from the evidence Loop holds, each row labelled with its source." />
      {all.seeded ? (
        <StateBlock kind="attention" compact title="Seeded demo data" body="Some or all of what is shown here was seeded to demonstrate the surface. It is not a platform report and says nothing about your real audience." />
      ) : null}
      {!all.connected ? <p className="loop-note">No platform is connected. Platform connections are not available yet; what is shown comes from rows EMG recorded or seeded.</p> : null}

      {nothing ? (
        <StateBlock kind="unavailable" title="Not connected" body="Analytics can only read what is connected, and platform connections are not available yet. When EMG records a report for you, it appears here with its source." />
      ) : (
        <>
          <nav className="loop-filters" aria-label="Platform">
            <Link className="loop-filter" href={href(null, days)} aria-current={platform === null ? 'true' : undefined}>
              All platforms
            </Link>
            {platforms.map((p) => (
              <Link key={p} className="loop-filter" href={href(p, days)} aria-current={platform === p ? 'true' : undefined}>
                {(SOCIAL_PLATFORM_LABELS as Record<string, string>)[p] ?? p}
              </Link>
            ))}
          </nav>
          <nav className="loop-filters" aria-label="Window">
            {WINDOWS.map((d) => (
              <Link key={d} className="loop-filter" href={href(platform, d)} aria-current={days === d ? 'true' : undefined}>
                {d} days
              </Link>
            ))}
          </nav>

          <SummaryStrip
            label="Summary"
            items={[
              { label: 'Views', value: view.performance.length > 0 ? compactNumber(view.totals.views) : null, unknownText: 'No reports in this window' },
              { label: 'Reach', value: view.performance.length > 0 ? compactNumber(view.totals.reach) : null, unknownText: 'No reports in this window' },
              { label: 'Engagements', value: view.performance.length > 0 ? compactNumber(view.totals.engagements) : null, unknownText: 'No reports in this window' },
              { label: 'Followers', value: followers === null ? null : compactNumber(followers), unknownText: 'No audience observed' },
            ]}
          />

          <Panel title="Audience over time">
            {audienceRows.length === 0 ? (
              <StateBlock kind="empty" compact title="No audience observations." body="An observation is a follower count read on a date. None is recorded for this selection." />
            ) : (
              <div className="ch-charts">
                {groupAudience(audienceRows).map((s) => (
                  <AudienceChart key={s.platform} series={s} time={time} />
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Top content">
            {view.topContent.length === 0 ? (
              <StateBlock kind="empty" compact title="No content has a report in this window." body="Once a published piece has a views report, it is ranked here." />
            ) : (
              <ol className="ch-list" aria-label="Top content by views">
                {view.topContent.map((c) => (
                  <li key={c.contentId}>
                    <Link className="ch-row" href={CREATOR_HREFS.contentRecord(c.contentId)}>
                      <span className="ch-row__main">
                        <span className="ch-row__title">{c.title}</span>
                        <span className="ch-row__meta">{(SOCIAL_PLATFORM_LABELS as Record<string, string>)[c.platform] ?? c.platform}</span>
                      </span>
                      <span className="ch-row__amount">{compactNumber(c.views)} views</span>
                    </Link>
                  </li>
                ))}
              </ol>
            )}
            <p className="loop-note" style={{ marginTop: 10 }}>
              {view.performance.length} report{view.performance.length === 1 ? '' : 's'} in the last {days} days
              {view.sources.length > 0 ? ` · sources: ${view.sources.map((s) => (s === 'SEEDED_DEMO' ? 'seeded demo data' : s === 'PLATFORM' ? 'platform' : s)).join(', ')}` : ''}
            </p>
          </Panel>
        </>
      )}
    </LoopPage>
  );
}
