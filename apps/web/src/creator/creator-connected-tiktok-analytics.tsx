import { matchingTikTokHandles } from './creator-tiktok-identity';
import { connectedTikTokOverview } from './creator-tiktok-overview';
import type { FeaturedFeedback } from './creator-featured-feedback';
import { CreatorPerformanceInsights } from './creator-performance-insights';
import type { TtoReport } from '@emgloop/providers';
import type { TikTokConnectionState, TimeView } from '@emgloop/shared';
import type { TikTokEntryView } from '../app/app/creator/_parts/tiktok-connection';
import { SummaryStrip, Panel, StateBlock } from '../app/app/_loop-os/record';
import { compactNumber } from '../app/app/creator/_parts/vocabulary';

/** A failed status read must not silently switch account identity to an agency report. */
export function selectTikTokAnalyticsSource(requested: string | null, state: TikTokConnectionState | null): 'ACCOUNT' | 'TIKTOK_ONE' {
  return state === 'NOT_CONNECTED' || state === 'NOT_CONFIGURED' ? 'TIKTOK_ONE' : 'ACCOUNT';
}

export { matchingTikTokHandles } from './creator-tiktok-identity';

export function CreatorConnectedTikTokAnalytics({ entry, publicReport, state, readFailed, time, feedback }: {
  entry: TikTokEntryView | null;
  publicReport?: { report: TtoReport | null; lastReadAt: Date | null; stale: boolean } | null;
  state: TikTokConnectionState | null;
  readFailed: boolean;
  time: TimeView;
  feedback?: FeaturedFeedback | null;
}) {
  const live = state === 'CONNECTED' || state === 'PARTIAL';
  if (!live || !entry || entry.seeded) return <Panel title="Connected TikTok account"><StateBlock
    kind={state === null ? 'error' : 'empty'} compact
    title={state === 'EXPIRED' ? 'Reconnect TikTok to see account analytics.' : 'No connected account report available.'}
    body="Manage your TikTok connection on Profile. Only authorized data for your account is displayed."
  /></Panel>;
  const count = (value: number | null | undefined) => value == null ? null : compactNumber(value);
  const overview = connectedTikTokOverview(entry, publicReport);
  return <div className="ch-platform-report" data-tiktok-source="ACCOUNT">
    <div className="ch-source-bar">
      <strong>TikTok · {entry.handle ? `@${entry.handle}` : 'Handle not provided'}</strong>
      <span>{overview.updatedAt ? `Updated ${time.dateTime(overview.updatedAt)}` : 'No completed reading'}</span>
      <span>{readFailed ? 'Refresh unavailable · last saved reading' : 'Latest saved reading'}</span>
    </div>
    {publicReport?.report && !matchingTikTokHandles(entry.handle,publicReport.report.handle)?<p className="loop-note" role="status">The connected account does not match your saved creator account. Only connected-account data is included. Review your account on Profile.</p>:null}
    {state === 'PARTIAL' ? <p className="loop-note">Some permissions were not granted. Unavailable metrics stay empty; review access on Profile.</p> : null}
    <SummaryStrip label="Connected TikTok account counts" items={[
      { label: 'Followers', value: count(overview.followers), unknownText: 'Not provided' },
      { label: 'Typical video views', value: count(overview.median), unknownText: 'Not available' },
      { label: 'Total likes', value: count(entry.stats?.likes), unknownText: 'Not provided' },
      { label: 'Videos', value: count(entry.stats?.videos), unknownText: 'Not provided' },
    ]} />
    <CreatorPerformanceInsights source="TikTok" videos={overview.videos} feedback={feedback} />
    <details className="ch-context-note"><summary>About these numbers</summary><p>These are the counts and recent public videos returned by the TikTok account authorized on Profile. Check the handle above belongs to you.</p><p>Unavailable reach, watch time and audience metrics are left out. Typical views may use a different reporting window from recent-post totals. Refresh checks for an update when the last reading is more than fifteen minutes old.</p></details>
    <details className="ch-analytics-video-details"><summary>All {overview.videos.length} videos · full performance breakdown</summary><Panel title="Recent public video performance">
      <div className="loop-table-wrap"><table className="loop-table" aria-label="Connected TikTok video performance">
        <thead><tr><th>Content</th><th>Posted</th><th>Views</th><th>Likes</th></tr></thead>
        <tbody>{overview.videos.map(video => <tr key={video.id}>
          <td>{video.url ? <a href={video.url} target="_blank" rel="noreferrer noopener">{video.title || 'View TikTok video'} ↗</a> : video.title || 'TikTok video'}</td>
          <td>{video.publishedAt ? time.dateTime(new Date(video.publishedAt)) : 'Not provided'}</td>
          <td>{count(video.views) ?? 'Not provided'}</td><td>{count(video.likes) ?? 'Not provided'}</td>
        </tr>)}</tbody>
      </table></div>
      {!overview.videos.length ? <StateBlock kind="empty" compact title="No public videos returned." body="This does not mean the account has no videos. Check your granted permissions on Profile." /> : null}
    </Panel></details>
  </div>;
}
