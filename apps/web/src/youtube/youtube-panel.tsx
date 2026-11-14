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
      <p className="loop-note">Check that this is the channel you want shown in your Creator Hub. <a href={`https://www.youtube.com/channel/${encodeURIComponent(data.connection.channelId)}`} target="_blank" rel="noreferrer">Review connected channel ↗</a></p>
      <div className="loop-btnrow">
        <a className="loop-btn loop-btn--primary" href="/app/creator/analytics?platform=YOUTUBE">View YouTube analytics</a>
        <a className="loop-btn" href="/api/integrations/youtube/connect" rel="nofollow">Reconnect YouTube</a>
        <form action="/api/integrations/youtube/disconnect" method="post"><button className="loop-btn" type="submit">Disconnect YouTube</button></form>
      </div>
    </>}
    <p className="loop-note">Loop does not upload, edit, or publish videos.</p>
  </Panel>;
}

export async function YouTubeAnalyticsPanel({ principal, syncOutcome }: { principal: Principal; syncOutcome?: string }) {
  const configured = readYouTubeEnvironment() !== null;
  if (!configured) return <Panel title="YouTube"><StateBlock kind="unavailable" compact title="YouTube is not configured" body="EMG is finishing the YouTube connection setup." /></Panel>;
  let data: Awaited<ReturnType<typeof getYouTubeCreatorConnection>> = null;
  try { data = await getYouTubeCreatorConnection(principal); }
  catch { return <Panel title="YouTube"><StateBlock kind="error" compact title="Could not read YouTube analytics" body="This is a temporary read failure, not a finding that the channel has no data." /></Panel>; }

  const syncText = syncOutcome === 'SYNCED' ? 'Analytics refreshed.' : syncOutcome === 'ALREADY_FRESH' ? 'Showing the latest saved snapshot.' : syncOutcome === 'NOT_CONNECTED' ? 'Connect YouTube from Profile before syncing.' : syncOutcome === 'NOT_CONFIGURED' ? 'YouTube is not configured on this deployment.' : syncOutcome === 'FAILED' ? 'Refresh failed. Your previous snapshot is still shown.' : null;
  const report = record(data?.observation?.report);
  const period = record(report.period);
  const daily = Array.isArray(report.daily) ? report.daily.map(record) : [];
  const topVideos = Array.isArray(report.topVideos) ? report.topVideos.map(record) : [];
  const trafficSources = Array.isArray(report.trafficSources) ? report.trafficSources.map(record) : [];
  const previousMetrics = record(record(report.previousPeriod).metrics);
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
  const viewsChange = number(previousMetrics.views) !== null && number(previousMetrics.views) !== 0 && totals.views !== undefined
    ? Math.round((totals.views - (number(previousMetrics.views) ?? 0)) * 100 / (number(previousMetrics.views) ?? 1))
    : null;
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
  const periodLabel = typeof period.startDate === 'string' && typeof period.endDate === 'string'
    ? period.startDate + ' – ' + period.endDate
    : 'Last 28 complete days';
  const dateLabel = (value: unknown) => typeof value === 'string'
    ? new Date(value + 'T00:00:00Z').toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : '';
  const engagementMetrics = ['likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost'];
  const hasEngagement = engagementMetrics.some(key => totals[key] !== undefined);
  const trafficViews = trafficSources.reduce((sum, item) => sum + (number(record(item.metrics).views) ?? 0), 0);
  const maxTrafficViews = Math.max(1, ...trafficSources.map(item => number(record(item.metrics).views) ?? 0));
  const sourceLabel = (value: unknown) => typeof value === 'string'
    ? value.toLowerCase().replace(/_/g, ' ').split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
    : 'Other';

  return <Panel title="YouTube">
    {syncText ? <p className="yt-sync" role="status">{syncText}</p> : null}
    {!data ? (
      <div className="yt-empty"><StateBlock kind="unavailable" compact title="YouTube is not connected" body="Connect your channel from Profile to view its analytics." /><a className="loop-btn loop-btn--primary" href="/app/creator/profile">Open Profile</a></div>
    ) : (
      <div className="yt-dashboard">
        <header className="yt-header">
          <div className="yt-header__identity">
            <h3>{data.connection.channelTitle}</h3>
            <p>{periodLabel}{data.observation?.observedAt ? ' · Updated ' + data.observation.observedAt.toLocaleString() : ' · No report fetched yet'}</p>
          </div>
          <form action="/api/integrations/youtube/sync" method="post">
            <button className="loop-btn loop-btn--primary yt-refresh" type="submit">Refresh</button>
          </form>
        </header>

        <section className="yt-kpis" aria-label="YouTube summary">
          <article className="yt-kpi yt-kpi--primary">
            <span className="yt-kpi__label">Views</span>
            <strong className="yt-kpi__value">{formatCount(totals.views)}</strong>
            {viewsChange !== null ? <span className="yt-kpi__detail">{viewsChange > 0 ? '+' : ''}{viewsChange}% vs previous 28 days</span> : null}
          </article>
          <article className="yt-kpi">
            <span className="yt-kpi__label">Watch time</span>
            <strong className="yt-kpi__value">{totals.estimatedMinutesWatched === undefined ? 'Not reported' : new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(totals.estimatedMinutesWatched / 60) + ' hr'}</strong>
          </article>
          <article className="yt-kpi">
            <span className="yt-kpi__label">Average view duration</span>
            <strong className="yt-kpi__value">{formatDuration(averageViewDuration)}</strong>
            {averageViewPercentage !== null ? <span className="yt-kpi__detail">{new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(averageViewPercentage)}% average viewed</span> : null}
          </article>
        </section>

        <section className="yt-section" aria-labelledby="yt-trends-title">
          <div className="yt-section__head"><h4 id="yt-trends-title">Views over time</h4></div>
          <article className="yt-chart-card yt-chart-card--wide">
            {chartValues.length ? <>
              <svg className="yt-chart" role="img" aria-label="Daily YouTube views over the last 28 complete days" viewBox="0 0 720 190" preserveAspectRatio="none">
                <line x1="10" y1="20" x2="710" y2="20" /><line x1="10" y1="84" x2="710" y2="84" /><line x1="10" y1="150" x2="710" y2="150" />
                <polyline points={chartPoints} />
              </svg>
              <div className="yt-chart-card__foot"><span>{dateLabel(daily[0]?.date)}</span><span>Peak {compact(String(peakDailyViews))} in one day</span><span>{dateLabel(daily[daily.length - 1]?.date)}</span></div>
            </> : <p className="yt-chart-empty">Daily views are not available in this report.</p>}
          </article>
        </section>

        {topVideos.length ? (
          <section className="yt-detail-card" aria-labelledby="yt-content-title">
            <div className="yt-section__head yt-section__head--compact"><h4 id="yt-content-title">Top videos</h4><span className="yt-count">Top {Math.min(topVideos.length, 3)}</span></div>
            <div className="yt-video-grid yt-video-grid--compact">
              {topVideos.slice(0, 3).map((item, index) => {
                const metrics = record(item.metrics);
                const videoId = typeof item.videoId === 'string' ? item.videoId : '';
                const title = typeof item.title === 'string' ? item.title : 'YouTube video';
                const thumbnailUrl = typeof item.thumbnailUrl === 'string' ? item.thumbnailUrl : null;
                const averageDuration = number(metrics.averageViewDuration);
                return <article className="yt-video" key={videoId || index}>
                  {videoId ? <a className="yt-video__thumb" href={'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId)} target="_blank" rel="noreferrer" aria-label={'Watch ' + title}>{thumbnailUrl ? <img src={thumbnailUrl} alt="" loading="lazy" /> : <span className="yt-video__placeholder">▶</span>}</a> : <div className="yt-video__thumb">{thumbnailUrl ? <img src={thumbnailUrl} alt="" loading="lazy" /> : <span className="yt-video__placeholder">▶</span>}</div>}
                  <div className="yt-video__body"><h5>{videoId ? <a href={'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId)} target="_blank" rel="noreferrer">{title}</a> : title}</h5>
                    <div className="yt-video__stats"><span><strong>{formatCount(number(metrics.views) ?? undefined)}</strong> views</span>{averageDuration !== null ? <span>{formatDuration(averageDuration)} avg.</span> : null}</div>
                  </div>
                </article>;
              })}
            </div>
          </section>
        ) : null}

        {trafficSources.length ? (
          <details className="yt-more">
            <summary>Traffic sources</summary>
            <div className="yt-sources">
              {trafficSources.slice(0, 5).map((item, index) => {
                const metrics = record(item.metrics);
                const views = number(metrics.views) ?? 0;
                const share = trafficViews > 0 ? views * 100 / trafficViews : 0;
                return <div className="yt-source" key={String(item.source ?? index)}>
                  <div className="yt-source__top"><span>{sourceLabel(item.source)}</span><strong>{compact(String(views))} <small>views</small></strong></div>
                  <div className="yt-source__bar"><span style={{ width: Math.max(0, Math.min(100, views * 100 / maxTrafficViews)) + '%' }} /></div>
                  <span className="yt-source__share">{new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(share)}% of reported traffic</span>
                </div>;
              })}
            </div>
          </details>
        ) : null}

        {hasEngagement ? (
          <details className="yt-more">
            <summary>Engagement and subscribers</summary>
            <div className="yt-more__grid">
              {engagementMetrics.filter(key => totals[key] !== undefined).map(key => (
                <div key={key}><span>{key === 'subscribersGained' ? 'Subscribers gained' : key === 'subscribersLost' ? 'Subscribers lost' : key[0]!.toUpperCase() + key.slice(1)}</span><strong>{formatCount(totals[key])}</strong></div>
              ))}
              {totals.subscribersGained !== undefined && totals.subscribersLost !== undefined ? <div><span>Net subscribers</span><strong>{compact(String(totals.subscribersGained - totals.subscribersLost))}</strong></div> : null}
            </div>
          </details>
        ) : null}

        <p className="yt-footnote">YouTube Analytics · read-only · 28 complete UTC days.</p>
      </div>
    )}
  </Panel>;
}
