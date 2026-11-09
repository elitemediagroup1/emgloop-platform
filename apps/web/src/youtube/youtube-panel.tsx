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

  return <Panel title="YouTube analytics">
    {syncText ? <p role="status">{syncText}</p> : null}
    {!data ? <><StateBlock kind="unavailable" compact title="YouTube is not connected" body="Connect your channel from Profile, then return here to refresh its analytics." /><a className="loop-btn" href="/app/creator/profile">Open Profile</a></> : <>
      <p className="loop-note">Latest stored YouTube Analytics API snapshot. The window is 28 complete UTC days; repeated windows are not added together.</p>
      {data.observation?.observedAt ? <p className="loop-note">Fetched {data.observation.observedAt.toLocaleString()} · {typeof period.startDate === 'string' && typeof period.endDate === 'string' ? period.startDate + ' to ' + period.endDate : 'period unavailable'}.</p> : <p className="loop-note">No analytics snapshot has been fetched yet. Refresh to request the latest report.</p>}
      <Facts rows={[
        { label: 'Channel', value: data.connection.channelTitle },
        { label: 'Views', value: formatCount(totals.views) },
        { label: 'Views vs prior 28 days', value: compareToPrevious(totals.views, number(previousMetrics.views)) },
        { label: 'Watch time', value: totals.estimatedMinutesWatched === undefined ? 'Not reported' : new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(totals.estimatedMinutesWatched / 60) + ' hours' },
        { label: 'Watch time vs prior 28 days', value: compareToPrevious(totals.estimatedMinutesWatched, number(previousMetrics.estimatedMinutesWatched)) },
        { label: 'Average view duration', value: formatDuration(averageViewDuration) },
        { label: 'Average viewed', value: averageViewPercentage === null ? 'Not reported' : new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(averageViewPercentage) + '%' },
        { label: 'Subscribers gained', value: formatCount(totals.subscribersGained) },
        { label: 'Subscribers lost', value: formatCount(totals.subscribersLost) },
        { label: 'Net subscribers', value: totals.subscribersGained === undefined || totals.subscribersLost === undefined ? 'Not reported' : (totals.subscribersGained - totals.subscribersLost >= 0 ? '+' : '') + compact(String(totals.subscribersGained - totals.subscribersLost)) },
        { label: 'Likes', value: formatCount(totals.likes) },
        { label: 'Comments', value: formatCount(totals.comments) },
        { label: 'Shares', value: formatCount(totals.shares) },
      ]} />

      <section aria-label="Daily YouTube views">
        <h3>Daily views</h3>
        {chartValues.length ? <>
          <svg role="img" aria-label="Line chart of daily YouTube views over the last 28 complete days" viewBox="0 0 720 170" style={{ display: 'block', width: '100%', maxWidth: '720px', height: 'auto' }}>
            <line x1="10" y1="150" x2="710" y2="150" stroke="currentColor" opacity="0.2" />
            <polyline fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" points={chartPoints} />
          </svg>
          <p className="loop-note">{daily.length} daily data points · peak {compact(String(peakDailyViews))} views in one day.</p>
        </> : <p className="loop-note">Daily trend data is not available in the latest report.</p>}
        <h4>Daily watch time</h4>
        {dailyWatchHours.length ? <>
          <svg role="img" aria-label="Line chart of daily YouTube watch time in hours over the last 28 complete days" viewBox="0 0 720 170" style={{ display: 'block', width: '100%', maxWidth: '720px', height: 'auto' }}>
            <line x1="10" y1="150" x2="710" y2="150" stroke="currentColor" opacity="0.2" />
            <polyline fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" points={watchPoints} />
          </svg>
          <p className="loop-note">Peak {new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(maxDailyWatchHours)} hours watched in one day.</p>
        </> : <p className="loop-note">Daily watch-time trend is not available in the latest report.</p>}
      </section>
      </section>

      <section aria-label="Top YouTube videos">
        <h3>Top videos</h3>
        {topVideos.length ? <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>Video</th><th>Views</th><th>Watch time</th><th>Avg. viewed</th><th>Likes</th><th>Comments</th></tr></thead>
            <tbody>{topVideos.map((item, index) => {
              const metrics = record(item.metrics);
              const videoId = typeof item.videoId === 'string' ? item.videoId : '';
              const title = typeof item.title === 'string' ? item.title : 'YouTube video';
              const thumbnailUrl = typeof item.thumbnailUrl === 'string' ? item.thumbnailUrl : null;
              return <tr key={videoId || index}>
                <td>{videoId ? <a href={'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId)} target="_blank" rel="noreferrer">{thumbnailUrl ? <img src={thumbnailUrl} alt="" width="96" height="54" loading="lazy" /> : null} {title}</a> : title}</td>
                <td>{formatCount(number(metrics.views) ?? undefined)}</td>
                <td>{number(metrics.estimatedMinutesWatched) === null ? 'Not reported' : new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format((number(metrics.estimatedMinutesWatched) ?? 0) / 60) + ' hr'}</td>
                <td>{number(metrics.averageViewPercentage) === null ? 'Not reported' : new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(number(metrics.averageViewPercentage) ?? 0) + '%'}</td>
                <td>{formatCount(number(metrics.likes) ?? undefined)}</td>
                <td>{formatCount(number(metrics.comments) ?? undefined)}</td>
              </tr>;
            })}</tbody>
          </table>
        </div> : <p className="loop-note">YouTube did not return a video breakdown for this period.</p>}
      </section>

      <section aria-label="YouTube traffic sources">
        <h3>Traffic sources</h3>
        {trafficSources.length ? <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>Source</th><th>Views</th><th>Watch time</th></tr></thead>
            <tbody>{trafficSources.map((item, index) => {
              const metrics = record(item.metrics);
              const source = typeof item.source === 'string' ? item.source.replace(/_/g, ' ').toLowerCase() : 'Other';
              return <tr key={source + index}>
                <td>{source}</td>
                <td>{formatCount(number(metrics.views) ?? undefined)}</td>
                <td>{number(metrics.estimatedMinutesWatched) === null ? 'Not reported' : new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format((number(metrics.estimatedMinutesWatched) ?? 0) / 60) + ' hr'}</td>
              </tr>;
            })}</tbody>
          </table>
        </div> : <p className="loop-note">Traffic-source details are not available in this snapshot. YouTube may limit some report rows when data is sparse.</p>}
      </section>

      <form action="/api/integrations/youtube/sync" method="post"><button className="loop-btn loop-btn--primary" type="submit">Refresh YouTube analytics</button></form>
    </>}
    <p className="loop-note">Unavailable metrics remain blank. Loop reads analytics only; it does not upload, edit, or publish videos.</p>
  </Panel>;
}
