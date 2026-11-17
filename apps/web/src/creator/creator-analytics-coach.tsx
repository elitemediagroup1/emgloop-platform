import { parseDomainReadingOutput, type TimeView } from '@emgloop/shared';
import type { AnalyticsReviewEvidence, AnalyticsSource } from '@emgloop/database';
export function CreatorAnalyticsCoach({review,source,time,outcome}:{review:{reading:unknown;evidence:unknown;generatedAt:Date|null}|null;source:AnalyticsSource;time:TimeView;outcome:string|null}){
  const raw=review?.reading && typeof review.reading==='object'?review.reading:{};
  const reading=parseDomainReadingOutput({schemaId:'domain-reading.v1',...raw})?.domainReading;
  const evidence=review?.evidence as AnalyticsReviewEvidence|undefined;
  const posts=new Map(evidence?.posts?.map(post=>[`analytics_post:${post.key}`,post])??[]);
  if(!reading)return <section className="ch-coach ch-coach--pending" aria-label="Loop AI review status"><strong>Loop AI</strong><p>{outcome==='NO_EVIDENCE'?'A performance review needs at least two recent posts with view counts.': 'Your AI review is not available yet. Refresh to check for an update.'}</p></section>;
  return <section className="ch-coach" aria-label="Loop AI performance coach">
    <header className="ch-coach__head"><div><p className="ch-performance-kicker">Loop AI · Creator coach</p><h2>Your next move.</h2><p className="loop-note">What’s working, where to improve, and an experiment to try next.</p></div></header>
    {outcome && outcome!=='ANALYZED'?<p role="status" className="loop-note">{outcome==='NO_EVIDENCE'?'Connect the correct account and refresh its data. A review needs at least two posts with available view counts.':outcome==='NOT_DUE'?'Your saved review is current, a review is already running, or the next review is not due yet.':'A new AI review is unavailable right now. Try again later.'}</p>:null}
    {reading?<><p className="ch-coach__summary">{reading.reading.statement}</p><div className="ch-coach__grid">{[
      {key:'praise',title:'What you’re doing well'},
      {key:'critique',title:'Where to improve'},
      {key:'experiment',title:'Try this next'},
    ].map(group=>{const signal=reading.signals.find(s=>s.key===group.key);return <article className="ch-coach__card" key={group.key}><h3>{group.title}</h3><p>{signal?.statement??'No supported feedback available.'}</p><div className="ch-coach__evidence">{signal?.evidenceRefs?.map(ref=>{const post=posts.get(ref);return post?.url?<a key={ref} href={post.url} target="_blank" rel="noreferrer noopener">View supporting post ↗</a>:null;})}</div></article>;})}</div><p className="ch-coach__foot">Generated {review?.generatedAt?time.dateTime(review.generatedAt):'at an unavailable time'} · TikTok · AI interpretation, not a guaranteed outcome.</p><details className="ch-coach__foot"><summary>What this review could and couldn’t assess</summary><ul>{reading.limitations.map(l=><li key={l}>{l}</li>)}</ul></details></>:<p className="ch-coach__summary">Request a review of your current post captions and performance. Loop will identify supported strengths, an improvement opportunity and a testable next idea. It has not watched your videos or listened to their audio.</p>}
  </section>;
}
