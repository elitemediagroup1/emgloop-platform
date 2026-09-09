// One person's queue, and why each thing sits above the next.
//
// THE ORDER COMES DECIDED, AND SO DOES ITS EXPLANATION. `PersonalQueueView`
// carries both the ordered items and the sentence for every adjacent pair,
// produced by the same walk that produced the order — so a rationalisation that
// disagreed with the sort is impossible. This surface renders them; it sorts
// nothing.
//
// NO SCORE. There is no governed priority number in this platform, and a
// "Priority: 87.4" would be a claim nobody could reconstruct. What a person gets
// instead is the tier, the reasons behind it, and the pairwise sentence.
//
// WHAT THE RANKING COULD NOT WEIGH IS SHOWN, NOT HIDDEN. Revenue exposure,
// client value, workload and reporting lines are not in this schema. An operator
// seeing an order should know it does not know those, rather than assuming it
// weighed them and found them small.

import Link from 'next/link';

import {
  RELEVANCE_TIER_LABELS,
  type PersonalPriorityView,
} from '@emgloop/shared';
import type { PersonalQueueView } from '@emgloop/database';

import { NotKnown, StateBadge } from '../../_loop-os/product-state';

function money(cents: number | null): string {
  // UNKNOWN IS NOT ZERO. An unmeasured effect renders as an em dash.
  return cents === null ? '—' : '$' + Math.round(cents / 100).toLocaleString('en-US');
}

function QueueItem({
  item,
  position,
  reasonBelow,
}: {
  item: PersonalPriorityView;
  position: number;
  reasonBelow: string | null;
}) {
  return (
    <li className="pq-item">
      <div className="pq-item__body">
        <span className="pq-item__n" aria-hidden="true">{position}</span>
        <div className="pq-item__main">
          <div className="pq-item__head">
            {/* THE TIER, IN THE WORDS THE CONTRACT SHIPS. Not a number. */}
            <span className="pq-item__tier">{RELEVANCE_TIER_LABELS[item.tier]}</span>
            <StateBadge state={item.significance.severity} />
            {item.significance.againstObjective ? (
              <span className="pq-item__against">Against an objective</span>
            ) : null}
          </div>

          <Link href={'/app/admin/cases/' + item.caseId} className="pq-item__link">
            Open investigation
          </Link>

          <dl className="pq-item__facts">
            <div>
              <dt>Measured effect</dt>
              {/* WHATEVER WAS ACTUALLY MEASURED, and an em dash otherwise. */}
              <dd>{money(item.significance.measuredImpactCents)}</dd>
            </div>
            {item.significance.percentageChange !== null ? (
              <div>
                <dt>Change</dt>
                <dd>{(item.significance.percentageChange * 100).toFixed(1)}%</dd>
              </div>
            ) : null}
          </dl>

          {/* WHY IT IS YOURS. Every reason names the row it came from, so an
              operator who disagrees can go and look. */}
          <details className="pq-item__why">
            <summary>Why this is yours</summary>
            <ul className="pq-reasons">
              {item.reasons.map((r) => (
                <li key={r.source + ':' + (r.sourceId ?? '')}>
                  <span className="pq-reasons__tier">{RELEVANCE_TIER_LABELS[r.tier]}</span>
                  <span className="pq-reasons__stmt">{r.statement}</span>
                  <span className="pq-reasons__src">
                    from {r.source.toLowerCase().replace(/_/g, ' ')}
                    {r.sourceId ? ' · ' + r.sourceId : ''}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </div>

      {/* THE PAIRWISE SENTENCE, produced by the same walk that produced the
          order. Rendered between the two items it compares, which is the only
          place it means anything. */}
      {reasonBelow ? (
        <p className="pq-because">
          <span className="pq-because__label">Why this is above the next</span>
          {reasonBelow}
        </p>
      ) : null}
    </li>
  );
}

export function PersonalQueue({ queue }: { queue: PersonalQueueView }) {
  if (queue.items.length === 0) {
    return (
      <div className="pq">
        {/* NOT "all clear". An empty personal queue says nothing about whether
            the business is fine — it says nothing is currently yours. The
            all-clear question is answered by the Headlines surface, from
            governed coverage. */}
        <p className="cw-notyet">
          Nothing is currently waiting on you. That is not the same as everything being fine —{' '}
          <Link href="/app/admin/headlines">today's Headlines</Link> answer that question.
        </p>
      </div>
    );
  }

  const reasonFor = (caseId: string): string | null =>
    queue.orderings.find((o) => o.aboveCaseId === caseId)?.statement ?? null;

  return (
    <div className="pq">
      <ol className="pq-list">
        {queue.items.map((item, i) => (
          <QueueItem
            key={item.caseId}
            item={item}
            position={i + 1}
            reasonBelow={reasonFor(item.caseId)}
          />
        ))}
      </ol>

      {/* PERSONAL PRIORITY IS NOT UNIVERSAL BUSINESS IMPACT, and the list of
          what was not weighed is the thing that keeps those apart. */}
      <NotKnown
        title="What this order could not take into account"
        lines={queue.notConsidered}
      />
    </div>
  );
}
