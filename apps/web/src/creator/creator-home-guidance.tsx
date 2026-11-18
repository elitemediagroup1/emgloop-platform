import 'server-only';
import Link from 'next/link';
import { creatorAnalyticsReviewRepository } from './creator-analytics-coach-runtime';
import { acceptedCreatorCoachReading } from './creator-coach-reading';
import { settle } from '../app/app/_home/settle';
import type { CreatorSeat } from './creator-runtime';
import type { TimeView } from '@emgloop/shared';
/** Home previews an authorized accepted review; visiting Home never purchases an AI call. */
export async function CreatorHomeGuidance({ seat, time }: { seat: CreatorSeat; time: TimeView }) {
  const result = await settle(async () => {
    const repo = creatorAnalyticsReviewRepository();
    for (const source of ['ACCOUNT', 'TIKTOK_ONE'] as const) {
      const current = await repo.current(seat.actor, source, time.now);
      if (current) return { review: current, earlier: false };
    }
    for (const source of ['ACCOUNT', 'TIKTOK_ONE'] as const) {
      const previous = await repo.previous(seat.actor, source, time.now);
      if (previous) return { review: previous, earlier: true };
    }
    return null;
  });
  if (!result.ok || !result.value) return null;
  const { review, earlier } = result.value,
    reading = acceptedCreatorCoachReading(review.reading);
  if (!reading) return null;
  const next = reading.signals.find((signal) => signal.key === 'experiment');
  return (
    <section className="ch-home-guidance" aria-label="Your personal performance guidance">
      <div>
        <span className="ch-eyebrow">Your creative edge · Loop AI</span>
        <h2>Build on what’s working.</h2>
        <p>{reading.reading.statement}</p>
      </div>
      <div className="ch-home-guidance__next">
        <span className="ch-eyebrow">Your next experiment</span>
        <p>{next?.statement}</p>
        <Link href="/app/creator/analytics">Read your personal review →</Link>
        <small>
          {earlier ? 'Earlier accepted review · ' : ''}
          {review.generatedAt ? time.dateTime(review.generatedAt) : 'Saved review'}
        </small>
      </div>
    </section>
  );
}
