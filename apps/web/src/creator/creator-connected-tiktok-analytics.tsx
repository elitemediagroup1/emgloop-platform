import { CreatorPerformanceInsights } from './creator-performance-insights';
import type { TtoReport } from '@emgloop/providers';
import type { TikTokConnectionState, TimeView } from '@emgloop/shared';
import type { TikTokEntryView } from '../app/app/creator/_parts/tiktok-connection';
import { SummaryStrip, Panel, StateBlock } from '../app/app/_loop-os/record';
import { compactNumber } from '../app/app/creator/_parts/vocabulary';

/** A failed status read must not silently switch account identity to an agency report. */
export function selectTikTokAnalyticsSource(requested: string | null, state: TikTokConnectionState | null): 'ACCOUNT' | 'TIKTOK_ONE' {
  if (requested === 'ACCOUNT' || requested === 'TIKTOK_ONE') return requested;
  return state === 'NOT_CONNECTED' || state === 'NOT_CONFIGURED' ? 'TIKTOK_ONE' : 'ACCOUNT';
}

/** Login Kit supplies no shared TikTok One id; require exact normalized handles, never display names. */
export function matchingTikTokHandles(account: string | null | undefined, report: string | null | undefined): boolean {
  const normalize = (value: string | null | undefined) => value?.trim().replace(/^@/, '').toLowerCase() ?? '';
  const a = normalize(account), b = normalize(report);
  return /^[a-z0-9._]+$/.test(a) && a === b;
}

export function CreatorConnectedTikTokAnalytics({ entry, publicReport, state, readFailed, time }: {
  entry: TikTokEntryView | null;
  publicReport?: { report: TtoReport | null; lastReadAt: Date | null; stale: boolean } | null;
  state: TikTokConnectionState | null;
  readFailed: boolean;
  time: TimeView;
}) {
  const live = state === 'CONNECTED' || state === 'PARTIAL';
  if (!live || !entry || entry.seeded) return <Panel title="Connected TikTok account"><StateBlock
    kind={state === null ? 'error' : 'empty'} compact
    title={state === 'EXPIRED' ? 'Reconnect TikTok to see account analytics.' : 'No connected account report available.'}
    body="Manage your TikTok connection on Profile. TikTok One reports remain a separate source."
  /></Panel>;
  const count = (value: number | null | undefined) => value == null ? null : compactNumber(value);
  const supplemental = publicReport?.report && matchingTikTokHandles(entry.handle, publicReport.report.handle) ? publicReport.report : null;
  return <div className="ch-platform-report" data-tiktok-source="ACCOUNT">
    <div className="ch-source-bar">
      <strong>TikTok · Connected account · {entry.handle ? `@${entry.handle}` : 'Handle not provided'}</strong>
      <span>{entry.readAt ? `Updated ${time.dateTime(entry.readAt)}` : 'No completed reading'}</span>
      <span>{readFailed ? 'Refresh unavailable · last saved reading' : 'Latest saved reading'}</span>
    </div>
    {state === 'PARTIAL' ? <p className="loop-note">Some permissions were not granted. Unavailable metrics stay empty; review access on Profile.</p> : null}
    <SummaryStrip label="Connected TikTok account counts" items={[
      { label: 'Followers', value: count(entry.stats?.followers), unknownText: 'Not provided' },
      { label: 'Following', value: count(entry.stats?.following), unknownText: 'Not provided' },
      { label: 'Total likes', value: count(entry.stats?.likes), unknownText: 'Not provided' },
      { label: 'Videos', value: count(entry.stats?.videos), unknownText: 'Not provided' },
    ]} />
    <CreatorPerformanceInsights source="Connected TikTok" videos={entry.recentVideos.map(v => ({ id: v.id, title: v.title, url: v.shareUrl, views: v.viewCount, likes: v.likeCount }))} />
    {supplemental ? <Panel title="TikTok One insights">
      <p className="loop-note">TikTok One · @{supplemental.handle} · {publicReport?.lastReadAt ? time.dateTime(publicReport.lastReadAt) : 'Report time unavailable'} · {publicReport?.stale ? 'Refresh pending · last saved report' : 'Latest saved report'}</p>
      <SummaryStrip label="Supplemental TikTok One report" items={[
        { label: 'Median views · TikTok One', value: count(supplemental.medianViews), unknownText: 'Not provided' },
      ]} />
      <p className="loop-note">TikTok One’s reported median complements the connected account counts above. It is not calculated from the ten recent videos and may use a different reporting period. View the TikTok One report for its full video breakdown.</p>
    </Panel> : publicReport?.report ? <p className="loop-note" role="status">TikTok One has a report for @{publicReport.report.handle}, which does not match this connected account. Those metrics are excluded from this overview. Review the separate TikTok One report or correct the account connection on Profile.</p> : null}
    <details className="ch-context-note"><summary>About your sources &amp; available metrics</summary><p>These are the counts and recent public videos returned by the TikTok account authorized on Profile. Check the handle above belongs to you.</p><p>Reach, watch time and private audience demographics are not supplied by this connection. Refresh checks for an update when the last reading is more than fifteen minutes old.</p></details>
    <Panel title="Recent public video performance">
      <div className="loop-table-wrap"><table className="loop-table" aria-label="Connected TikTok video performance">
        <thead><tr><th>Content</th><th>Posted</th><th>Views</th><th>Likes</th></tr></thead>
        <tbody>{entry.recentVideos.map(video => <tr key={video.id}>
          <td>{video.shareUrl ? <a href={video.shareUrl} target="_blank" rel="noreferrer noopener">{video.title || 'View TikTok video'} ↗</a> : video.title || 'TikTok video'}</td>
          <td>{video.createdAt ? time.dateTime(video.createdAt) : 'Not provided'}</td>
          <td>{count(video.viewCount) ?? 'Not provided'}</td><td>{count(video.likeCount) ?? 'Not provided'}</td>
        </tr>)}</tbody>
      </table></div>
      {!entry.recentVideos.length ? <StateBlock kind="empty" compact title="No public videos returned." body="This does not mean the account has no videos. Check your granted permissions on Profile." /> : null}
    </Panel>
  </div>;
}
