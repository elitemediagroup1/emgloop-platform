import { acceptedCreatorCoachReading } from './creator-coach-reading';
import { type TimeView } from '@emgloop/shared';
import type { AnalyticsReviewEvidence, AnalyticsSource } from '@emgloop/database';
export function CreatorAnalyticsCoach({
  review,
  source,
  time,
  outcome,
  status,
  earlier = false,
}: {
  review: { reading: unknown; evidence: unknown; generatedAt: Date | null } | null;
  source: AnalyticsSource;
  time: TimeView;
  outcome: string | null;
  status?: { state: string; failure: string | null; nextAttemptAt: Date | null } | null;
  earlier?: boolean;
}) {
  const reading = acceptedCreatorCoachReading(review?.reading);
  const evidence = review?.evidence as AnalyticsReviewEvidence | undefined;
  const posts = new Map(evidence?.posts?.map((post) => [`analytics_post:${post.key}`, post]) ?? []);
  const reason = status?.failure ?? '';
  const pendingText =
    outcome === 'NO_EVIDENCE' || status?.state === 'NO_EVIDENCE'
      ? 'A review needs at least two posts with view counts.'
      : /BUDGET|ALLOWANCE|DAILY|TOKEN_LIMIT/.test(reason)
        ? 'Your AI allowance is currently paused. Your metrics remain available; EMG can review the allowance without you reconnecting.'
        : /TASK_NOT_ENABLED|PROVIDER|POLICY|NOT_AUTHORIZED|CONTROLS|CONFIGURED/.test(reason)
          ? 'EMG needs to complete the AI review setup. Your account data is available; reconnecting will not fix this.'
          : status?.state === 'PENDING'
            ? 'Your performance review is being prepared.'
            : /REJECTED|INVALID|REFUSED_BY_MODEL/.test(reason)
              ? 'The last review did not meet Loop’s evidence checks. It was withheld; your team can review the issue.'
              : 'A performance review has not completed yet.';
  if (!reading)
    return (
      <section className="ch-coach ch-coach--pending" aria-label="Loop AI review status">
        <strong>Loop AI</strong>
        <p>
          {pendingText}
          {status?.nextAttemptAt && status.nextAttemptAt > time.now
            ? ` Next eligible check: ${time.dateTime(status.nextAttemptAt)}.`
            : ''}{' '}
          <a href="/app/creator/tasks#team">Ask EMG →</a>
        </p>
      </section>
    );
  return (
    <section className="ch-coach" aria-label="Loop AI performance coach">
      {earlier ? (
        <p role="status" className="loop-note">
          Earlier accepted review. Your metrics have changed since this reading; its observations
          refer to the supporting posts and counts recorded then.
        </p>
      ) : null}
      <header className="ch-coach__head">
        <div>
          <p className="ch-performance-kicker">Loop AI · Creator coach</p>
          <h2>Your next move.</h2>
          <p className="loop-note">
            What’s working, where to improve, and an experiment to try next.
          </p>
        </div>
      </header>
      {outcome && outcome !== 'ANALYZED' ? (
        <p role="status" className="loop-note">
          {outcome === 'NO_EVIDENCE'
            ? 'Connect the correct account and refresh its data. A review needs at least two posts with available view counts.'
            : outcome === 'NOT_DUE'
              ? 'Your saved review is current, a review is already running, or the next review is not due yet.'
              : 'A new AI review is unavailable right now. Try again later.'}
        </p>
      ) : null}
      {reading ? (
        <>
          <p className="ch-coach__summary">{reading.reading.statement}</p>
          <div className="ch-coach__grid">
            {[
              { key: 'praise', title: 'What you’re doing well' },
              { key: 'critique', title: 'Where to improve' },
              { key: 'experiment', title: 'Try this next' },
            ].map((group) => {
              const signal = reading.signals.find((s) => s.key === group.key);
              return (
                <article className="ch-coach__card" key={group.key}>
                  <h3>{group.title}</h3>
                  <p>{signal?.statement ?? 'No supported feedback available.'}</p>
                  <div className="ch-coach__evidence">
                    {signal?.evidenceRefs?.map((ref) => {
                      const post = posts.get(ref);
                      return post?.url ? (
                        <a key={ref} href={post.url} target="_blank" rel="noreferrer noopener">
                          View supporting post ↗
                        </a>
                      ) : null;
                    })}
                  </div>
                </article>
              );
            })}
          </div>
          <p className="ch-coach__foot">
            Generated{' '}
            {review?.generatedAt ? time.dateTime(review.generatedAt) : 'at an unavailable time'} ·
            TikTok · AI interpretation, not a guaranteed outcome.
          </p>
          <details className="ch-coach__foot">
            <summary>What this review could and couldn’t assess</summary>
            <ul>
              {reading.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <p className="ch-coach__summary">
          Request a review of your current post captions and performance. Loop will identify
          supported strengths, an improvement opportunity and a testable next idea. It has not
          watched your videos or listened to their audio.
        </p>
      )}
    </section>
  );
}
