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
  const daily = Array.isArray(report.daily) ? report.daily : [];
  const totals: Record<string, number> = {};
  for (const row of daily) {
    const metrics = record(record(row).metrics);
    for (const [key, raw] of Object.entries(metrics)) {
      const value = number(raw);
      if (value !== null) totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return <Panel title="YouTube analytics">
    {syncText ? <p role="status">{syncText}</p> : null}
    {!data ? <><StateBlock kind="unavailable" compact title="YouTube is not connected" body="Connect your channel from Profile, then return here to refresh its analytics." /><a className="loop-btn" href="/app/creator/profile">Open Profile</a></> : <>
      <p className="loop-note">Latest stored YouTube Analytics API snapshot. The window is 28 complete UTC days; repeated windows are not added together.</p>
      {data.observation?.observedAt ? <p className="loop-note">Fetched {data.observation.observedAt.toLocaleString()} · {typeof period.startDate === 'string' && typeof period.endDate === 'string' ? `${period.startDate} to ${period.endDate}` : 'period unavailable'}.</p> : <p className="loop-note">No analytics snapshot has been fetched yet.</p>}
      <Facts rows={[
        { label: 'Channel', value: data.connection.channelTitle },
        { label: 'Views in period', value: totals.views === undefined ? 'Not reported' : compact(String(totals.views)) },
        { label: 'Watch time', value: totals.estimatedMinutesWatched === undefined ? 'Not reported' : `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(totals.estimatedMinutesWatched / 60)} hours` },
        { label: 'Subscribers gained', value: totals.subscribersGained === undefined ? 'Not reported' : compact(String(totals.subscribersGained)) },
        { label: 'Subscribers lost', value: totals.subscribersLost === undefined ? 'Not reported' : compact(String(totals.subscribersLost)) },
      ]} />
      <form action="/api/integrations/youtube/sync" method="post"><button className="loop-btn loop-btn--primary" type="submit">Refresh YouTube analytics</button></form>
    </>}
    <p className="loop-note">Unavailable metrics remain blank. Loop reads analytics only; it does not upload, edit, or publish videos.</p>
  </Panel>;
}
