import { readYouTubeEnvironment } from './youtube-environment';
import { getYouTubeCreatorConnection } from './youtube-server';
import { Panel, StateBlock } from '../app/app/_loop-os/record';

type Principal = { organizationId: string; userId: string };
const OUTCOMES: Record<string, string> = {
  CONNECTED: 'YouTube is connected. Run a sync to load channel analytics.',
  DECLINED: 'You declined access. Nothing was connected.',
  DISCONNECTED: 'YouTube access was removed from Loop.',
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

export async function YouTubeConnectionPanel({ principal, outcome, syncOutcome }: { principal: Principal; outcome?: string; syncOutcome?: string }) {
  const configured = readYouTubeEnvironment() !== null;
  const statusText = outcome ? OUTCOMES[outcome] : null;
  const syncText = syncOutcome === 'SYNCED' ? 'Analytics were refreshed.' : syncOutcome === 'NOT_CONNECTED' ? 'Connect YouTube before syncing analytics.' : syncOutcome === 'NOT_CONFIGURED' ? 'YouTube connection is not configured on this deployment.' : syncOutcome === 'FAILED' ? 'The analytics refresh did not complete. Your previous snapshot is still shown.' : null;
  if (!configured) return <Panel title="YouTube"><StateBlock kind="unavailable" compact title="Awaiting YouTube setup" body="EMG is finishing the YouTube connection setup. Your YouTube account will connect separately from Instagram and Facebook." /></Panel>;

  let data: Awaited<ReturnType<typeof getYouTubeCreatorConnection>> = null;
  try {
    data = await getYouTubeCreatorConnection({ ...principal, sessionId: '' });
  } catch {
    return <Panel title="YouTube"><StateBlock kind="error" compact title="Loop could not check your YouTube connection." body="This is a temporary check failure, not a finding that no connection exists." /></Panel>;
  }

  const report = record(data?.observation?.report);
  const period = record(report.period);
  const daily = Array.isArray(report.daily) ? report.daily : [];
  const totals: Record<string, number> = {};
  for (const row of daily) {
    const metrics = record(record(row).metrics);
    for (const [key, raw] of Object.entries(metrics)) {
      const value = number(raw);
      if (value !== null) totals[key] = (totals[key] ?? 0) + value;
    }
  }

  return <Panel title="YouTube">
    <p className="loop-note">Connect your YouTube channel to read channel analytics. You can disconnect access at any time.</p>
    {statusText ? <p role="status">{statusText}</p> : null}
    {syncText ? <p role="status">{syncText}</p> : null}
    {!data ? <>
      <p>No YouTube channel is connected.</p>
      <a className="loop-btn loop-btn--primary" href="/api/integrations/youtube/connect" rel="nofollow">Connect YouTube</a>
    </> : <>
      <dl className="loop-facts">
        <div><dt>Channel</dt><dd><a href={`https://www.youtube.com/channel/${encodeURIComponent(data.connection.channelId)}`} target="_blank" rel="noreferrer">{data.connection.channelTitle}</a></dd></div>
        <div><dt>Subscribers</dt><dd>{compact(data.connection.subscriberCount)}</dd></div>
        <div><dt>Lifetime views</dt><dd>{compact(data.connection.lifetimeViewCount)}</dd></div>
        <div><dt>Videos</dt><dd>{compact(data.connection.videoCount)}</dd></div>
        <div><dt>Analytics period</dt><dd>{typeof period.startDate === 'string' && typeof period.endDate === 'string' ? `${period.startDate} to ${period.endDate}` : 'Not synced yet'}</dd></div>
        <div><dt>Views in period</dt><dd>{totals.views === undefined ? 'Not available' : compact(String(totals.views))}</dd></div>
        <div><dt>Watch time</dt><dd>{totals.estimatedMinutesWatched === undefined ? 'Not available' : `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(totals.estimatedMinutesWatched / 60)} hours`}</dd></div>
        <div><dt>Subscribers gained</dt><dd>{totals.subscribersGained === undefined ? 'Not available' : compact(String(totals.subscribersGained))}</dd></div>
      </dl>
      {data.observation?.observedAt ? <p className="loop-note">Last refreshed {data.observation.observedAt.toLocaleString()}.</p> : <p className="loop-note">Analytics have not been synced yet.</p>}
      <div className="loop-btnrow">
        <form action="/api/integrations/youtube/sync" method="post"><button className="loop-btn loop-btn--primary" type="submit">Refresh YouTube analytics</button></form>
        <form action="/api/integrations/youtube/disconnect" method="post"><button className="loop-btn" type="submit">Disconnect YouTube</button></form>
      </div>
    </>}
    <p className="loop-note">Loop reads your channel’s analytics only. It does not upload, edit, or publish videos.</p>
  </Panel>;
}
