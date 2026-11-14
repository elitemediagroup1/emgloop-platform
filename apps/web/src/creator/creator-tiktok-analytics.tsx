import type { TtoReport } from '@emgloop/providers';
import type { TimeView } from '@emgloop/shared';
import { SummaryStrip, Panel, StateBlock } from '../app/app/_loop-os/record';
import { compactNumber } from '../app/app/creator/_parts/vocabulary';
export function CreatorTikTokAnalytics({
  report,
  updatedAt,
  stale,
  time,
}: {
  report: TtoReport;
  updatedAt: Date | null;
  stale: boolean;
  time: TimeView;
}) {
  return (
    <div className="ch-platform-report">
      <div className="ch-source-bar">
        <strong>TikTok One · Public report</strong>
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
          { label: 'Videos in this report', value: String(report.videos.length) },
          { label: 'Reach', value: null, unknownText: 'Not provided' },
        ]}
      />
      <div className="ch-analytics-context">
        <Panel title="Audience history">
          <StateBlock
            kind="empty"
            compact
            title="A current snapshot, not a growth trend."
            body="This public report does not provide a historical audience series. Growth will be shown when enough dated platform observations are available."
          />
        </Panel>
        <aside className="ch-context-note">
          <h2>What this tells you</h2>
          <p>
            This is TikTok One’s public creator report. Individual view counts are the provider’s
            reported totals for those videos.
          </p>
          <p>
            Reach, private audience demographics and watch time are not supplied by this connection.
            Missing metrics are left empty.
          </p>
        </aside>
      </div>
      <Panel title="Reported content performance">
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
      </Panel>
    </div>
  );
}
