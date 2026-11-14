import 'server-only';
import type { TimeView } from '@emgloop/shared';
import { getYouTubeCreatorConnection } from '../youtube/youtube-server';
import { ttoMediaRepository } from '../tiktok-business/runtime';
import { settle } from '../app/app/_home/settle';
import type { CreatorSeat } from './creator-runtime';
import { compactNumber } from '../app/app/creator/_parts/vocabulary';
export interface PublishedMedia {
  key: string;
  platform: 'TIKTOK' | 'YOUTUBE';
  title: string;
  url: string;
  thumbnail: string | null;
  views: number | null;
  reportedAt: Date;
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const number = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
export function youtubePublishedMedia(
  data: Awaited<ReturnType<typeof getYouTubeCreatorConnection>>,
): PublishedMedia[] {
  if (!data?.observation) return [];
  const report = object(data.observation.report);
  if (!Array.isArray(report.topVideos)) return [];
  const seen = new Set<string>();
  return report.topVideos.slice(0, 25).flatMap((raw) => {
    const row = object(raw),
      id = typeof row.videoId === 'string' ? row.videoId : '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id) || seen.has(id)) return [];
    seen.add(id);
    let thumbnail: string | null = null;
    if (typeof row.thumbnailUrl === 'string')
      try {
        const u = new URL(row.thumbnailUrl);
        if (
          u.protocol === 'https:' &&
          !u.username &&
          !u.password &&
          (u.hostname === 'i.ytimg.com' || u.hostname.endsWith('.ytimg.com'))
        )
          thumbnail = u.toString();
      } catch {}
    return [
      {
        key: `youtube:${id}`,
        platform: 'YOUTUBE' as const,
        title: typeof row.title === 'string' ? row.title.slice(0, 200) : 'YouTube video',
        url: `https://www.youtube.com/watch?v=${id}`,
        thumbnail,
        views: number(object(row.metrics).views),
        reportedAt: data.observation!.observedAt,
      },
    ];
  });
}
export async function loadCreatorPublishedMedia(seat: CreatorSeat) {
  const principal = { organizationId: seat.actor.organizationId, userId: seat.actor.userId };
  const [tiktok, youtube] = await Promise.all([
    settle(() => ttoMediaRepository().read(principal, seat.profileId, new Date())),
    settle(() => getYouTubeCreatorConnection(principal)),
  ]);
  const report = tiktok.ok ? tiktok.value : null;
  const rows: PublishedMedia[] =
    report?.report && report.lastReadAt
      ? report.report.videos.map((v) => ({
          key: `tiktok:${v.id}`,
          platform: 'TIKTOK',
          title: v.caption || 'TikTok video',
          url: v.url,
          thumbnail: v.thumbnailUrl,
          views: v.views,
          reportedAt: report.lastReadAt!,
        }))
      : [];
  if (youtube.ok) rows.push(...youtubePublishedMedia(youtube.value));
  return { rows, incomplete: !tiktok.ok || !youtube.ok };
}
export function PublishedMediaGrid({
  items,
  time,
}: {
  items: readonly PublishedMedia[];
  time: TimeView;
}) {
  return (
    <ul className="ch-published-grid" aria-label="Published social content">
      {items.map((item) => (
        <li key={item.key}>
          <a className="ch-published-card" href={item.url} target="_blank" rel="noreferrer">
            <div className="ch-published-card__image">
              {item.thumbnail ? (
                <img src={item.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                <span>No preview provided</span>
              )}
              <span className="ch-published-play" aria-hidden="true">
                ↗
              </span>
            </div>
            <div className="ch-published-card__body">
              <span className="ch-eyebrow">
                {item.platform === 'TIKTOK' ? 'TikTok' : 'YouTube'}
              </span>
              <h3>{item.title}</h3>
              <div>
                <span>Watch ↗</span>
                <strong>
                  {item.views === null
                    ? 'Views not reported'
                    : `${compactNumber(item.views)} views`}
                </strong>
              </div>
              <small>Report updated {time.relative(item.reportedAt)}</small>
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
