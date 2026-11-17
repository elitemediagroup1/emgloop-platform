import type { TtoReport } from '@emgloop/providers';
import type { TikTokEntryView } from '../app/app/creator/_parts/tiktok-connection';
import { matchingTikTokHandles } from './creator-tiktok-identity';
import type { PerformanceVideo } from './creator-performance-insights';
export function connectedTikTokOverview(entry:TikTokEntryView, publicReport?:{report:TtoReport|null;lastReadAt:Date|null}|null){
 const report=publicReport?.report && matchingTikTokHandles(entry.handle,publicReport.report.handle)?publicReport.report:null;
 const newer=Boolean(report && publicReport?.lastReadAt && (!entry.readAt || +publicReport.lastReadAt>+entry.readAt));
 const videos=new Map<string,PerformanceVideo>();
 for(const v of entry.recentVideos)videos.set(v.id,{id:v.id,title:v.title,url:v.shareUrl,views:v.viewCount,likes:v.likeCount,publishedAt:v.createdAt?.toISOString()??null});
 for(const v of report?.videos??[]){
  const own=videos.get(v.id),external={id:v.id,title:v.caption,url:v.url,views:v.views,likes:v.likes,thumbnail:v.thumbnailUrl,publishedAt:v.createdAt};
  videos.set(v.id,own?{...own,thumbnail:v.thumbnailUrl,title:newer?(v.caption||own.title):(own.title||v.caption),url:own.url??v.url,views:newer?(v.views??own.views):(own.views??v.views),likes:newer?(v.likes??own.likes):(own.likes??v.likes)}:external);
 }
 const recent=[...videos.values()].sort((a,b)=>(Date.parse(b.publishedAt??'')||0)-(Date.parse(a.publishedAt??'')||0)).slice(0,10);
 return {videos:recent,followers:newer?(report?.followers??entry.stats?.followers??null):(entry.stats?.followers??report?.followers??null),median:report?.medianViews??null,updatedAt:newer?publicReport?.lastReadAt:entry.readAt};
}
