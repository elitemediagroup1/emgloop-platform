import { CreatorPerformanceInsights } from './creator-performance-insights';
import type { FeaturedFeedback } from './creator-featured-feedback';
import type { TtoReport } from '@emgloop/providers';
import type { TimeView } from '@emgloop/shared';
import { SummaryStrip, Panel, StateBlock } from '../app/app/_loop-os/record';
import { compactNumber } from '../app/app/creator/_parts/vocabulary';
export function CreatorTikTokAnalytics({
  report,
  updatedAt,
  stale,
  time,
  feedback,
}: {
  report: TtoReport;
  updatedAt: Date | null;
  stale: boolean;
  time: TimeView;
  feedback?: FeaturedFeedback | null;
}) {
  return (
    <div className="ch-platform-report">
      <div className="ch-source-bar">
        <strong>TikTok · @{report.handle}</strong>
        <span>{updatedAt ? `Updated ${time.dateTime(updatedAt)}` : 'Update time unavailable'}</span>
        <span>{stale ? 'Refresh pending' : 'Latest saved report'}</span>
      </div>
      <SummaryStrip
        label="TikTok public performance"
        items={[
          {
            label: 'Followers',
            value: report.followers === null ? null : compactNumber(report.followers),
            unknownText: 'Not provided',
          },
          {
            label: 'Median views',
            value: report.medianViews === null ? null : compactNumber(report.medianViews),
            unknownText: 'Not provided',
          },
          {
            label: 'Latest reported video views',
            value: report.videos[0]?.views == null ? null : compactNumber(report.videos[0].views),
            unknownText: 'Not provided',
          },
          { label: 'Recent posts', value: String(report.videos.length) },
        ]}
      />
      <CreatorPerformanceInsights feedback={feedback} source="TikTok" videos={report.videos.map(v => ({ id: v.id, title: v.caption, url: v.url, views: v.views, likes: v.likes, thumbnail: v.thumbnailUrl, publishedAt: v.createdAt }))} />
      <details className="ch-context-note"><summary>About these numbers</summary><p>Reach, private audience demographics, watch time and historical audience series are not available in these readings. This report does not provide a historical audience series. No growth trend is shown.</p></details>
      <details className="ch-analytics-video-details"><summary>All {report.videos.length} videos · full performance breakdown</summary><Panel title="Reported content performance">
        <div className="loop-table-wrap">
          <table className="loop-table" aria-label="TikTok video performance">
            <thead>
              <tr>
                <th>Content</th>
                <th>Views</th>
                <th>Likes</th>
                <th>Comments</th>
                <th>Shares</th>
              </tr>
            </thead>
            <tbody>
              {report.videos.map((v) => (
                <tr key={v.id}>
                  <td>
                    <a
                      className="ch-performance-content"
                      href={v.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {v.thumbnailUrl ? (
                        <img
                          src={v.thumbnailUrl}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      ) : null}
                      <span>{v.caption || 'View TikTok video'} ↗</span>
                    </a>
                  </td>
                  {[v.views, v.likes, v.comments, v.shares].map((value, i) => (
                    <td key={i}>{value === null ? 'Not reported' : compactNumber(value)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!report.videos.length ? (
          <StateBlock
            kind="empty"
            compact
            title="No videos returned in this report."
            body="This does not mean you have no published videos."
          />
        ) : null}
      </Panel></details>
    </div>
  );
}
