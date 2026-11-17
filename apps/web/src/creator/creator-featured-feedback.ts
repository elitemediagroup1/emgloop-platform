import { parseDomainReadingOutput } from '@emgloop/shared';
export interface FeaturedFeedback {videoId:string;summary:string;experiment:string|null}
/** Only attach feedback that explicitly cites the currently selected post, never another winner's review. */
export function featuredPostFeedback(review:{reading:unknown;evidence:unknown}|null,videoId:string|undefined):FeaturedFeedback|null{
 if(!review||!videoId)return null;
 const raw=review.reading&&typeof review.reading==='object'?review.reading:{};
 const reading=parseDomainReadingOutput({schemaId:'domain-reading.v1',...raw})?.domainReading;
 const evidence=review.evidence as {posts?:{key:string;url:string|null}[]}|null;
 const post=evidence?.posts?.find(post=>post.url?.match(/\/video\/(\d+)/)?.[1]===videoId);
 if(!post||!reading)return null;
 const ref=`analytics_post:${post.key}`;
 const praise=reading.signals.find(s=>s.key==='praise'&&s.evidenceRefs?.includes(ref));
 if(!praise)return null;
 const experiment=reading.signals.find(s=>s.key==='experiment'&&s.evidenceRefs?.includes(ref));
 return {videoId,summary:praise.statement,experiment:experiment?.statement??null};
}
