import { CreatorAudienceInsights } from './creator-audience-insights';
import { CreatorVideoHistory, videoHistorySets } from './creator-video-history';
import { CreatorPerformanceInsights } from './creator-performance-insights';
import type { FeaturedFeedback } from './creator-featured-feedback';
import type { TtoReport } from '@emgloop/providers';
import type { TimeView } from '@emgloop/shared';
import { SummaryStrip } from '../app/app/_loop-os/record';
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
  const allVideos=report.videos.map(v=>({id:v.id,title:v.caption,url:v.url,views:v.views,likes:v.likes,comments:v.comments,shares:v.shares,thumbnail:v.thumbnailUrl,publishedAt:v.createdAt}));
  const recent=videoHistorySets(allVideos).recent;
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
          { label: 'Imported videos', value: String(report.videos.length) },
        ]}
      />
      <CreatorPerformanceInsights feedback={feedback} source="TikTok" videos={recent} />
      <CreatorAudienceInsights audience={report.audience}/>
      <CreatorVideoHistory videos={allVideos} complete={report.history?.complete===true && !report.history.capped} time={time}/>
      <details className="ch-context-note"><summary>About these numbers</summary><p>Typical views use TikTok’s latest 30-video median. Video counts are lifetime snapshots, not views earned during a reporting period. Watch time, retention and an audience growth series were not returned by this integration. Missing audience breakdowns are identified individually above.</p></details>
    </div>
  );
}
