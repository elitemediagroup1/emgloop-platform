import type { FeaturedFeedback } from './creator-featured-feedback';
import { compactNumber } from '../app/app/creator/_parts/vocabulary';

export interface PerformanceVideo {
  id: string;
  title: string | null;
  url: string | null;
  views: number | null;
  likes: number | null;
  thumbnail?: string | null;
  publishedAt?: string | null;
}

/** Every calculation is over the returned sample, never an account-wide or time-window estimate. */
export function performanceSample(videos: readonly PerformanceVideo[]) {
  const known = videos.filter(v => v.views !== null && Number.isFinite(v.views) && v.views >= 0);
  const ranked = [...known].sort((a, b) => b.views! - a.views!);
  const views = known.reduce((sum, v) => sum + v.views!, 0);
  const paired = known.filter(v => v.likes !== null && Number.isFinite(v.likes) && v.likes >= 0);
  const pairedViews = paired.reduce((sum, v) => sum + v.views!, 0);
  const pairedLikes = paired.reduce((sum, v) => sum + v.likes!, 0);
  const ordered=known.map(v=>v.views!).sort((a,b)=>a-b);
  const middle=Math.floor(ordered.length/2);
  const median=ordered.length?(ordered.length%2?ordered[middle]!:(ordered[middle-1]!+ordered[middle]!)/2):null;
  return { ranked, median, views: known.length ? views : null, known: known.length, paired: paired.length,
    likeRate: pairedViews > 0 ? pairedLikes / pairedViews * 100 : null };
}

export function CreatorPerformanceInsights({ videos, source: _source, feedback }: { videos: readonly PerformanceVideo[]; source: string; feedback?: FeaturedFeedback | null }) {
  const sample = performanceSample(videos), best = sample.ranked[0];
  const top = sample.ranked.slice(0, 5), max = best?.views ?? 0;
  const comparison=best && sample.median!==null && sample.median>0 ? best.views!/sample.median : null;
  const share=best && sample.views!==null && sample.views>0 ? best.views!/sample.views*100 : null;
  const postFeedback=feedback?.videoId===best?.id?feedback:null;
  const title=best?.title?.replace(/#[\p{L}\p{N}_]+/gu,'').trim();
  return <section className="ch-performance-lab" aria-label="Recent content insights">
    <div className="ch-performance-lab__main">
      <div className="ch-performance-lab__heading"><div><p className="ch-performance-kicker">Your recent performance</p><h2>The posts making an impact.</h2></div><span className="ch-performance-badge">{videos.length} recent posts</span></div>
      <div className="ch-performance-numbers">
        <div><span>Views across recent posts</span><strong>{sample.views === null ? '—' : compactNumber(sample.views)}</strong><small>{sample.known} of {videos.length} posts have reported views</small></div>
        <div><span>Likes per 100 views</span><strong>{sample.likeRate === null ? '—' : sample.likeRate.toFixed(1)}</strong><small>{sample.paired} videos with both counts · not total engagement</small></div>
      </div>
      <div className="ch-performance-lab__chart-title"><h3>Your most-viewed content</h3><span>Total views · recent posts</span></div>
      {top.length ? <ol className="ch-performance-bars" aria-label="Videos ranked by reported views">
        {top.map((video, index) => <li key={video.id}>
          <span className="ch-performance-bars__rank">{String(index + 1).padStart(2, '0')}</span>
          <div className="ch-performance-bars__item"><div className="ch-performance-bars__label">{video.url ? <a href={video.url} target="_blank" rel="noreferrer noopener">{video.title || 'Untitled TikTok video'}</a> : <span>{video.title || 'Untitled TikTok video'}</span>}<strong>{compactNumber(video.views!)}</strong></div><div className="ch-performance-bars__track" aria-hidden="true"><span style={{ width: `${max > 0 ? video.views! / max * 100 : 0}%` }} /></div></div>
        </li>)}
      </ol> : <p className="loop-note">A comparison appears when TikTok returns video view counts. Missing counts are not treated as zero.</p>}
      <p className="ch-performance-lab__foot">A snapshot of the available videos, not a 30-day report. Videos have different posting dates and time to accumulate views.</p>
    </div>
    <aside className="ch-performance-spotlight">
      <p className="ch-performance-kicker">Leading recent post</p>
      {best ? <>
        {best.thumbnail ? <img src={best.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <div className="ch-performance-spotlight__number"><strong>{compactNumber(best.views!)}</strong><span>reported views</span></div>}
        <span className="ch-performance-badge">Most viewed in this recent set</span>
        <h3>{title || 'Your leading recent post'}</h3>
        <p className="ch-featured-summary">This post leads your recent set with <strong>{compactNumber(best.views!)}</strong> views{comparison!==null && comparison>1 ? `—${comparison.toFixed(1)}× the median of these ${sample.known} posts` : ''}.{share!==null && share>0 ? ` It accounts for ${share.toFixed(1)}% of the views across this set.` : ''}</p>
        {best.likes!==null?<p>{compactNumber(best.likes)} likes reported on this post.</p>:null}
        {postFeedback?<div className="ch-featured-ai"><span>Loop AI · What’s working</span><p>{postFeedback.summary}</p>{postFeedback.experiment?<><span>A next experiment</span><p>{postFeedback.experiment}</p></>:null}</div>:null}
        <p className="ch-featured-context">Updates automatically when another recent post takes the lead in reported views.</p>
        {best.url ? <a className="loop-btn" href={best.url} target="_blank" rel="noreferrer noopener">Watch this post ↗</a> : null}
      </> : <><h3>Your next insight starts here.</h3><p>Connect your account or refresh an available report to see which returned content has the most reported views.</p></>}
    </aside>
  </section>;
}
