import { compactNumber } from '../app/app/creator/_parts/vocabulary';
import type { PerformanceVideo } from './creator-performance-insights';
import type { TimeView } from '@emgloop/shared';
export function videoHistorySets(videos: readonly PerformanceVideo[]) {
  const unique = [...new Map(videos.map((v) => [v.id, v])).values()];
  return {
    recent: [...unique]
      .sort(
        (a, b) => (Date.parse(b.publishedAt ?? '') || 0) - (Date.parse(a.publishedAt ?? '') || 0),
      )
      .slice(0, 14),
    top: unique
      .filter((v) => v.views !== null)
      .sort((a, b) => b.views! - a.views! || a.id.localeCompare(b.id))
      .slice(0, 10),
  };
}
export function CreatorVideoHistory({
  videos,
  complete = false,
  time,
}: {
  videos: readonly PerformanceVideo[];
  complete?: boolean;
  time: TimeView;
}) {
  const sets = videoHistorySets(videos);
  complete = complete && videos.every((v) => v.views !== null);
  return (
    <section className="ch-video-history" aria-label="Video performance history">
      {[
        {
          title: '14 Newest Videos',
          posts: sets.recent,
          note: 'Latest imported posts, newest first. Up to 14 videos.',
        },
        {
          title: complete ? 'Top 10 All-Time Videos' : 'Top 10 Among Imported Videos',
          posts: sets.top,
          note: complete
            ? 'Highest reported lifetime views across available public video history. Private or deleted videos are excluded.'
            : 'Ranked by reported lifetime views. History import is still incomplete; this is not an all-time ranking.',
        },
      ].map((set) => (
        <details className="ch-analytics-video-details" key={set.title}>
          <summary>
            {set.title} · {set.posts.length} available
          </summary>
          <p className="loop-note">
            {set.note} {videos.length} videos imported.
          </p>
          <div className="loop-table-wrap">
            <table className="loop-table" aria-label={set.title}>
              <thead>
                <tr>
                  <th>Content</th>
                  <th>Posted</th>
                  <th>Views</th>
                  <th>Likes</th>
                  <th>Comments</th>
                  <th>Shares</th>
                </tr>
              </thead>
              <tbody>
                {set.posts.map((v) => (
                  <tr key={v.id}>
                    <td>
                      {v.url ? (
                        <a
                          className="ch-performance-content"
                          href={v.url}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {v.thumbnail ? (
                            <img
                              src={v.thumbnail}
                              alt=""
                              loading="lazy"
                              referrerPolicy="no-referrer"
                            />
                          ) : null}
                          <span>{v.title || 'TikTok video'} ↗</span>
                        </a>
                      ) : (
                        v.title || 'TikTok video'
                      )}
                    </td>
                    <td>
                      {v.publishedAt ? time.dateTime(new Date(v.publishedAt)) : 'Not reported'}
                    </td>
                    <td>{v.views === null ? 'Not provided' : compactNumber(v.views)}</td>
                    <td>{v.likes === null ? 'Not provided' : compactNumber(v.likes)}</td>
                    <td>{v.comments == null ? 'Not provided' : compactNumber(v.comments)}</td>
                    <td>{v.shares == null ? 'Not provided' : compactNumber(v.shares)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!set.posts.length ? <p className="loop-note">No videos returned yet.</p> : null}
        </details>
      ))}
    </section>
  );
}
