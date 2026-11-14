import type { TtoReport } from '@emgloop/providers';
import type { TimeView } from '@emgloop/shared';
import { compactNumber } from '../app/app/creator/_parts/vocabulary';
export function CreatorTikTokContent({ report, lastReadAt, stale, time }: {
    report: TtoReport;
    lastReadAt: Date | null;
    stale: boolean;
    time: TimeView;
}) {
    const feature = report.videos.find(v => v.thumbnailUrl);
    return <section className="ch-editorial-content" aria-label="Your TikTok content">
    <header><h2>Your content</h2><a href={`https://www.tiktok.com/@${report.handle}`} target="_blank" rel="noreferrer">TikTok ↗</a></header>
    {feature ? <a className="ch-editorial-feature" href={feature.url} target="_blank" rel="noreferrer"><img src={feature.thumbnailUrl!} alt="" loading="lazy" referrerPolicy="no-referrer"/><span>{feature.caption || 'Watch on TikTok'}<small>{feature.views === null ? 'Views unavailable' : `${compactNumber(feature.views)} views`} ↗</small></span></a> : null}
    <ul>{report.videos.filter(v => v.id !== feature?.id).slice(0, 4).map(v => <li key={v.id}><a href={v.url} target="_blank" rel="noreferrer">{v.thumbnailUrl ? <img src={v.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer"/> : null}{v.caption || 'Watch on TikTok'}<span>↗</span></a></li>)}</ul>
    {!report.videos.length ? <p>No public videos returned by TikTok.</p> : null}
    <p className="loop-note">{report.followers === null ? 'Follower count unavailable' : `${compactNumber(report.followers)} TikTok followers`}{report.medianViews === null ? '' : ` · ${compactNumber(report.medianViews)} median views`}. Public TikTok One data{lastReadAt ? ` · updated ${time.relative(lastReadAt)}` : ''}{stale ? ' · refresh pending' : ''}.</p>
  </section>;
}
