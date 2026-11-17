import { compactNumber } from '../app/app/creator/_parts/vocabulary';

export interface PerformanceVideo {
  id: string;
  title: string | null;
  url: string | null;
  views: number | null;
  likes: number | null;
  thumbnail?: string | null;
}

/** Every calculation is over the returned sample, never an account-wide or time-window estimate. */
export function performanceSample(videos: readonly PerformanceVideo[]) {
  const known = videos.filter(v => v.views !== null && Number.isFinite(v.views) && v.views >= 0);
  const ranked = [...known].sort((a, b) => b.views! - a.views!);
  const views = known.reduce((sum, v) => sum + v.views!, 0);
  const paired = known.filter(v => v.likes !== null && Number.isFinite(v.likes) && v.likes >= 0);
  const pairedViews = paired.reduce((sum, v) => sum + v.views!, 0);
  const pairedLikes = paired.reduce((sum, v) => sum + v.likes!, 0);
  return { ranked, views: known.length ? views : null, known: known.length, paired: paired.length,
    likeRate: pairedViews > 0 ? pairedLikes / pairedViews * 100 : null };
}

export function CreatorPerformanceInsights({ videos, source }: { videos: readonly PerformanceVideo[]; source: string }) {
  const sample = performanceSample(videos), best = sample.ranked[0];
  const top = sample.ranked.slice(0, 5), max = best?.views ?? 0;
  return <section className="ch-performance-lab" aria-label="Recent content insights">
    <div className="ch-performance-lab__main">
      <div className="ch-performance-lab__heading"><div><p className="ch-performance-kicker">Performance lab · {source}</p><h2>See what connects.</h2></div><span className="ch-performance-badge">{videos.length} returned videos</span></div>
      <div className="ch-performance-numbers">
        <div><span>Views across returned videos</span><strong>{sample.views === null ? '—' : compactNumber(sample.views)}</strong><small>{sample.known} of {videos.length} videos have reported views</small></div>
        <div><span>Likes per 100 views</span><strong>{sample.likeRate === null ? '—' : sample.likeRate.toFixed(1)}</strong><small>{sample.paired} videos with both counts · not total engagement</small></div>
      </div>
      <div className="ch-performance-lab__chart-title"><h3>Your most-viewed content</h3><span>Lifetime views · returned sample</span></div>
      {top.length ? <ol className="ch-performance-bars" aria-label="Videos ranked by reported views">
        {top.map((video, index) => <li key={video.id}>
          <span className="ch-performance-bars__rank">{String(index + 1).padStart(2, '0')}</span>
          <div className="ch-performance-bars__item"><div className="ch-performance-bars__label">{video.url ? <a href={video.url} target="_blank" rel="noreferrer noopener">{video.title || 'Untitled TikTok video'}</a> : <span>{video.title || 'Untitled TikTok video'}</span>}<strong>{compactNumber(video.views!)}</strong></div><div className="ch-performance-bars__track" aria-hidden="true"><span style={{ width: `${max > 0 ? video.views! / max * 100 : 0}%` }} /></div></div>
        </li>)}
      </ol> : <p className="loop-note">A comparison appears when TikTok returns video view counts. Missing counts are not treated as zero.</p>}
      <p className="ch-performance-lab__foot">A snapshot of the available videos, not a 30-day report. Videos have different posting dates and time to accumulate views.</p>
    </div>
    <aside className="ch-performance-spotlight">
      <p className="ch-performance-kicker">Content spotlight</p>
      {best ? <>
        {best.thumbnail ? <img src={best.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <div className="ch-performance-spotlight__number"><strong>{compactNumber(best.views!)}</strong><span>reported views</span></div>}
        <span className="ch-performance-badge">Highest views in this sample</span>
        <h3>{best.title || 'Your leading returned video'}</h3>
        <p>Review this video’s opening, topic and format alongside your other posts. View count alone does not establish why it performed differently.</p>
        {best.url ? <a className="loop-btn" href={best.url} target="_blank" rel="noreferrer noopener">Review the video ↗</a> : null}
      </> : <><h3>Your next insight starts here.</h3><p>Connect your account or refresh an available report to see which returned content has the most reported views.</p></>}
    </aside>
  </section>;
}
