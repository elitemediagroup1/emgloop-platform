import { readYouTubeEnvironment } from './youtube-environment';
import { getYouTubeCreatorConnection } from './youtube-server';
import { Panel, StateBlock, Facts } from '../app/app/_loop-os/record';

type Principal = { organizationId: string; userId: string };
const OUTCOMES: Record<string, string> = {
  CONNECTED: 'YouTube is connected.',
  DECLINED: 'You declined access. Nothing was connected.',
  DISCONNECTED: 'Loop removed its saved YouTube token. You can also remove Loop from your Google Account’s third-party access settings.',
  NOT_CONNECTED: 'There is no YouTube connection to remove.',
  NOT_CONFIGURED: 'YouTube connection is not configured on this deployment.',
  NOT_PERMITTED: 'This login is not linked to a creator profile.',
  STATE_INVALID: 'That authorization expired or was started in another session. Start again here.',
  TOO_MANY_ATTEMPTS: 'Too many unfinished connection attempts. Wait ten minutes, then try again.',
  INVALID_REQUEST: 'Start the connection from this page.',
  ACCOUNT_IN_USE: 'That YouTube channel is already connected to another creator in this organization.',
  CHANNEL_UNAVAILABLE: 'Google did not return a YouTube channel for this account.',
  FAILED: 'Google could not complete the connection. Try again.',
};
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const compact = (value: string | null) => value && /^\d+$/.test(value) ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value)) : 'Not available';

export async function YouTubeConnectionPanel({ principal, outcome }: { principal: Principal; outcome?: string }) {
  const configured = readYouTubeEnvironment() !== null;
  if (!configured) return <Panel title="YouTube"><StateBlock kind="unavailable" compact title="Awaiting YouTube setup" body="EMG is finishing the YouTube connection setup. Your YouTube account will connect separately from Instagram and Facebook." /></Panel>;
  let data: Awaited<ReturnType<typeof getYouTubeCreatorConnection>> = null;
  try { data = await getYouTubeCreatorConnection(principal); }
  catch { return <Panel title="YouTube"><StateBlock kind="error" compact title="Loop could not check your YouTube connection." body="This is a temporary check failure, not a finding that no connection exists." /></Panel>; }
  const outcomeText = outcome ? OUTCOMES[outcome] : null;
  return <Panel title="YouTube">
    <p className="loop-note">Connect your YouTube channel separately from Instagram and Facebook. Loop requests read-only channel analytics.</p>
    {outcomeText ? <p role="status">{outcomeText}</p> : null}
    {!data ? <>
      <p>No YouTube channel is connected.</p>
      <a className="loop-btn loop-btn--primary" href="/api/integrations/youtube/connect" rel="nofollow">Connect YouTube</a>
    </> : <>
      <Facts rows={[
        { label: 'Channel', value: data.connection.channelTitle },
        { label: 'Subscribers', value: compact(data.connection.subscriberCount) },
        { label: 'Lifetime views', value: compact(data.connection.lifetimeViewCount) },
        { label: 'Videos', value: compact(data.connection.videoCount) },
      ]} />
      <div className="loop-btnrow">
        <a className="loop-btn loop-btn--primary" href="/app/creator/analytics">View YouTube analytics</a>
        <a className="loop-btn" href="/api/integrations/youtube/connect" rel="nofollow">Reconnect YouTube</a>
        <form action="/api/integrations/youtube/disconnect" method="post"><button className="loop-btn" type="submit">Disconnect YouTube</button></form>
      </div>
    </>}
    <p className="loop-note">Loop does not upload, edit, or publish videos.</p>
  </Panel>;
}

export async function YouTubeAnalyticsPanel({ principal, syncOutcome }: { principal: Principal; syncOutcome?: string }) {
  const configured = readYouTubeEnvironment() !== null;
  if (!configured) return <Panel title="YouTube analytics"><StateBlock kind="unavailable" compact title="YouTube is not configured" body="EMG is finishing the YouTube connection setup." /></Panel>;
  let data: Awaited<ReturnType<typeof getYouTubeCreatorConnection>> = null;
  try { data = await getYouTubeCreatorConnection(principal); }
  catch { return <Panel title="YouTube analytics"><StateBlock kind="error" compact title="Could not read YouTube analytics" body="This is a temporary read failure, not a finding that the channel has no data." /></Panel>; }

  const syncText = syncOutcome === 'SYNCED' ? 'Analytics were refreshed.' : syncOutcome === 'ALREADY_FRESH' ? 'Analytics were refreshed recently; showing the latest saved snapshot.' : syncOutcome === 'NOT_CONNECTED' ? 'Connect YouTube from Profile before syncing analytics.' : syncOutcome === 'NOT_CONFIGURED' ? 'YouTube is not configured on this deployment.' : syncOutcome === 'FAILED' ? 'The analytics refresh did not complete. Your previous snapshot is still shown.' : null;
  const report = record(data?.observation?.report);
  const period = record(report.period);
  const daily = Array.isArray(report.daily) ? report.daily.map(record) : [];
  const topVideos = Array.isArray(report.topVideos) ? report.topVideos.map(record) : [];
  const trafficSources = Array.isArray(report.trafficSources) ? report.trafficSources.map(record) : [];
  const previousPeriod = record(report.previousPeriod);
  const previousMetrics = record(previousPeriod.metrics);
  const totals: Record<string, number> = {};
  let percentageWeighted = 0;
  let percentageViews = 0;
  for (const row of daily) {
    const metrics = record(row.metrics);
    for (const [key, raw] of Object.entries(metrics)) {
      if (key === 'averageViewDuration' || key === 'averageViewPercentage') continue;
      const value = number(raw);
      if (value !== null) totals[key] = (totals[key] ?? 0) + value;
    }
    const views = number(metrics.views);
    const percentage = number(metrics.averageViewPercentage);
    if (views !== null && percentage !== null) {
      percentageWeighted += views * percentage;
      percentageViews += views;
    }
  }
  const averageViewDuration = totals.views && totals.estimatedMinutesWatched !== undefined
    ? totals.estimatedMinutesWatched * 60 / totals.views
    : null;
  const averageViewPercentage = percentageViews > 0 ? percentageWeighted / percentageViews : null;
  const compareToPrevious = (current: number | undefined, previous: number | null) => {
    if (current === undefined || previous === null) return 'Not available';
    if (previous === 0) return current === 0 ? 'No change' : 'New activity';
    const change = Math.round((current - previous) * 100 / previous);
    return (change > 0 ? '+' : '') + change + '% vs prior 28 days';
  };
  const formatDuration = (value: number | null) => {
    if (value === null) return 'Not reported';
    const seconds = Math.round(value);
    return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
  };
  const formatCount = (value: number | undefined) => value === undefined ? 'Not reported' : compact(String(value));
  const chartValues = daily.flatMap(row => {
    const value = number(record(row.metrics).views);
    return value === null ? [] : [value];
  });
  const peakDailyViews = Math.max(0, ...chartValues);
  const maxDailyViews = Math.max(1, peakDailyViews);
  const chartPoints = chartValues.map((value, index) => {
    const x = chartValues.length <= 1 ? 360 : 10 + index * (700 / (chartValues.length - 1));
    const y = 150 - value * 130 / maxDailyViews;
    return x + ',' + y;
  }).join(' ');
  const dailyWatchHours = daily.flatMap(row => {
    const value = number(record(row.metrics).estimatedMinutesWatched);
    return value === null ? [] : [value / 60];
  });
  const maxDailyWatchHours = Math.max(1, ...dailyWatchHours);
  const watchPoints = dailyWatchHours.map((value, index) => {
    const x = dailyWatchHours.length <= 1 ? 360 : 10 + index * (700 / (dailyWatchHours.length - 1));
    const y = 150 - value * 130 / maxDailyWatchHours;
    return x + ',' + y;
  }).join(' ');

  const periodLabel = typeof period.startDate === 'string' && typeof period.endDate === 'string'
    ? period.startDate + ' – ' + period.endDate
    : 'Last 28 complete days';
  const channelName = data?.connection.channelTitle ?? 'YouTube channel';
  const netSubscribers = totals.subscribersGained === undefined || totals.subscribersLost === undefined
    ? null
    : totals.subscribersGained - totals.subscribersLost;
  const trafficViews = trafficSources.reduce((sum, item) => sum + (number(record(item.metrics).views) ?? 0), 0);
  const maxTrafficViews = Math.max(1, ...trafficSources.map(item => number(record(item.metrics).views) ?? 0));
  const sourceLabel = (value: unknown) => typeof value === 'string'
    ? value.toLowerCase().replace(/_/g, ' ').split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
    : 'Other';
  const shortDate = (value: unknown) => typeof value === 'string'
    ? new Date(value + 'T00:00:00Z').toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : '';

  return <Panel title="YouTube performance">
    {syncText ? <p className="yt-sync" role="status">{syncText}</p> : null}
    {!data ? <div className="yt-empty"><StateBlock kind="unavailable" compact title="YouTube is not connected" body="Connect your channel from Profile, then return here to refresh its analytics." /><a className="loop-btn loop-btn--primary" href="/app/creator/profile">Open Profile</a></div> : <>
      <div className="yt-dashboard">
        <header className="yt-header">
          <div className="yt-header__identity">
            <span className="yt-eyebrow"><span className="yt-mark" aria-hidden="true">▶</span> Channel analytics</span>
            <h3>{channelName}</h3>
            <p>Understand what your audience watched and how your videos performed.</p>
          </div>
          <form action="/api/integrations/youtube/sync" method="post">
            <button className="loop-btn loop-btn--primary yt-refresh" type="submit"><span aria-hidden="true">↻</span> Refresh data</button>
          </form>
        </header>

        <div className="yt-meta">
          <span className="yt-meta__status"><i aria-hidden="true" /> Connected</span>
          <span>{periodLabel}</span>
          <span>{data.observation?.observedAt ? 'Updated ' + data.observation.observedAt.toLocaleString() : 'No snapshot yet · refresh to load your first report'}</span>
        </div>

        <section className="yt-kpis" aria-label="YouTube performance summary">
          <article className="yt-kpi yt-kpi--primary">
            <span className="yt-kpi__label">Views</span>
            <strong className="yt-kpi__value">{formatCount(totals.views)}</strong>
            <span className="yt-kpi__detail">{compareToPrevious(totals.views, number(previousMetrics.views))}</span>
          </article>
          <article className="yt-kpi">
            <span className="yt-kpi__label">Watch time</span>
            <strong className="yt-kpi__value">{totals.estimatedMinutesWatched === undefined ? 'Not reported' : new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(totals.estimatedMinutesWatched / 60) + ' hr'}</strong>
            <span className="yt-kpi__detail">{compareToPrevious(totals.estimatedMinutesWatched, number(previousMetrics.estimatedMinutesWatched))}</span>
          </article>
          <article className="yt-kpi">
            <span className="yt-kpi__label">Average view duration</span>
            <strong className="yt-kpi__value">{formatDuration(averageViewDuration)}</strong>
            <span className="yt-kpi__detail">{averageViewPercentage === null ? 'Average viewed not reported' : new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(averageViewPercentage) + '% average viewed'}</span>
          </article>
          <article className="yt-kpi">
            <span className="yt-kpi__label">Net subscribers</span>
            <strong className="yt-kpi__value">{netSubscribers === null ? 'Not reported' : (netSubscribers > 0 ? '+' : '') + compact(String(netSubscribers))}</strong>
            <span className="yt-kpi__detail">{totals.subscribersGained === undefined ? 'Gained and lost not reported' : totals.subscribersLost === undefined ? compact(String(totals.subscribersGained)) + ' gained · losses not reported' : compact(String(totals.subscribersGained)) + ' gained · ' + compact(String(totals.subscribersLost)) + ' lost'}</span>
          </article>
        </section>

        <section className="yt-section" aria-labelledby="yt-trends-title">
          <div className="yt-section__head">
            <div><span className="yt-eyebrow">Performance</span><h4 id="yt-trends-title">Your channel over time</h4></div>
            <span className="yt-window">28 day view</span>
          </div>
          <div className="yt-chart-grid">
            <article className="yt-chart-card">
              <div className="yt-chart-card__head"><div><span>Views</span><strong>{formatCount(totals.views)}</strong></div><span className="yt-chart-card__glyph yt-chart-card__glyph--views" aria-hidden="true">↗</span></div>
              {chartValues.length ? <>
                <svg className="yt-chart" role="img" aria-label="Daily YouTube views over the last 28 complete days" viewBox="0 0 720 190" preserveAspectRatio="none">
                  <defs><linearGradient id="yt-views-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--loop-accent)" stopOpacity=".22" /><stop offset="100%" stopColor="var(--loop-accent)" stopOpacity="0" /></linearGradient></defs>
                  <line x1="10" y1="20" x2="710" y2="20" /><line x1="10" y1="84" x2="710" y2="84" /><line x1="10" y1="150" x2="710" y2="150" />
                  <polygon points={chartPoints + ' 710,150 10,150'} fill="url(#yt-views-fill)" stroke="none" />
                  <polyline points={chartPoints} />
                </svg>
                <div className="yt-chart-card__foot"><span>{shortDate(daily[0]?.date)}</span><span>Peak {compact(String(peakDailyViews))} in one day</span><span>{shortDate(daily[daily.length - 1]?.date)}</span></div>
              </> : <p className="yt-chart-empty">Daily trend data is not available yet.</p>}
            </article>
            <article className="yt-chart-card">
              <div className="yt-chart-card__head"><div><span>Watch time</span><strong>{totals.estimatedMinutesWatched === undefined ? 'Not reported' : new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(totals.estimatedMinutesWatched / 60) + ' hr'}</strong></div><span className="yt-chart-card__glyph yt-chart-card__glyph--watch" aria-hidden="true">◷</span></div>
              {dailyWatchHours.length ? <>
                <svg className="yt-chart yt-chart--watch" role="img" aria-label="Daily YouTube watch time in hours over the last 28 complete days" viewBox="0 0 720 190" preserveAspectRatio="none">
                  <defs><linearGradient id="yt-watch-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--loop-primary-hover)" stopOpacity=".2" /><stop offset="100%" stopColor="var(--loop-primary-hover)" stopOpacity="0" /></linearGradient></defs>
                  <line x1="10" y1="20" x2="710" y2="20" /><line x1="10" y1="84" x2="710" y2="84" /><line x1="10" y1="150" x2="710" y2="150" />
                  <polygon points={watchPoints + ' 710,150 10,150'} fill="url(#yt-watch-fill)" stroke="none" />
                  <polyline points={watchPoints} />
                </svg>
                <div className="yt-chart-card__foot"><span>{shortDate(daily[0]?.date)}</span><span>Peak {new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(maxDailyWatchHours)} hr/day</span><span>{shortDate(daily[daily.length - 1]?.date)}</span></div>
              </> : <p className="yt-chart-empty">Daily watch time is not available yet.</p>}
            </article>
          </div>
        </section>

        <div className="yt-detail-grid">
          <section className="yt-detail-card" aria-labelledby="yt-content-title">
            <div className="yt-section__head yt-section__head--compact"><div><span className="yt-eyebrow">Content</span><h4 id="yt-content-title">Top videos</h4></div><span className="yt-count">{topVideos.length} videos</span></div>
            {topVideos.length ? <div className="yt-video-grid">
              {topVideos.slice(0, 6).map((item, index) => {
                const metrics = record(item.metrics);
                const videoId = typeof item.videoId === 'string' ? item.videoId : '';
                const title = typeof item.title === 'string' ? item.title : 'YouTube video';
                const thumbnailUrl = typeof item.thumbnailUrl === 'string' ? item.thumbnailUrl : null;
                return <article className="yt-video" key={videoId || index}>
                  {videoId ? <a className="yt-video__thumb" href={'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId)} target="_blank" rel="noreferrer" aria-label={'Watch ' + title}>
                    {thumbnailUrl ? <img src={thumbnailUrl} alt="" loading="lazy" /> : <span className="yt-video__placeholder">▶</span>}
                  </a> : <div className="yt-video__thumb">{thumbnailUrl ? <img src={thumbnailUrl} alt="" loading="lazy" /> : <span className="yt-video__placeholder">▶</span>}</div>}
                  <div className="yt-video__body"><h5>{videoId ? <a href={'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId)} target="_blank" rel="noreferrer">{title}</a> : title}</h5>
                    <div className="yt-video__stats"><span><strong>{formatCount(number(metrics.views) ?? undefined)}</strong> views</span><span>{number(metrics.averageViewPercentage) === null ? '—' : new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(number(metrics.averageViewPercentage) ?? 0) + '% viewed'}</span></div>
                  </div>
                </article>;
              })}
            </div> : <p className="yt-chart-empty">YouTube did not return a video breakdown for this period.</p>}
          </section>

          <section className="yt-detail-card" aria-labelledby="yt-sources-title">
            <div className="yt-section__head yt-section__head--compact"><div><span className="yt-eyebrow">Discovery</span><h4 id="yt-sources-title">Where viewers found you</h4></div></div>
            {trafficSources.length ? <div className="yt-sources">
              {trafficSources.slice(0, 8).map((item, index) => {
                const metrics = record(item.metrics);
                const views = number(metrics.views) ?? 0;
                const share = trafficViews > 0 ? views * 100 / trafficViews : 0;
                return <div className="yt-source" key={String(item.source ?? index)}>
                  <div className="yt-source__top"><span>{sourceLabel(item.source)}</span><strong>{compact(String(views))} <small>views</small></strong></div>
                  <div className="yt-source__bar"><span style={{ width: Math.max(0, Math.min(100, views * 100 / maxTrafficViews)) + '%' }} /></div>
                  <span className="yt-source__share">{new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(share)}% of reported traffic</span>
                </div>;
              })}
            </div> : <p className="yt-chart-empty">Traffic sources are not available in this snapshot.</p>}
          </section>
        </div>

        <details className="yt-more">
          <summary>Engagement details <span>Likes, comments, shares, and subscriber movement</span></summary>
          <div className="yt-more__grid">
            <div><span>Likes</span><strong>{formatCount(totals.likes)}</strong></div>
            <div><span>Comments</span><strong>{formatCount(totals.comments)}</strong></div>
            <div><span>Shares</span><strong>{formatCount(totals.shares)}</strong></div>
            <div><span>Subscribers gained</span><strong>{formatCount(totals.subscribersGained)}</strong></div>
            <div><span>Subscribers lost</span><strong>{formatCount(totals.subscribersLost)}</strong></div>
          </div>
        </details>

        <p className="yt-footnote">Source: YouTube Analytics API · 28 complete UTC days · unavailable metrics are left unreported. Loop reads analytics only; it does not upload, edit, or publish videos.</p>
      </div>
    </>}
  </Panel>;
}
