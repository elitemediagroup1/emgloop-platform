// NEEDS YOU on Home -- the few items a background source (Telegram today) flagged as needing this
// person. Source-agnostic by construction: it renders whatever `loadNeedsYou` returns, each row
// carrying its own source label and provenance. It is NOT a Telegram inbox and NOT a second mail
// surface: there is no conversation browser, no reply, and no message content -- the title is the AI's
// minimized paraphrase, and Loop points the person back to the source to act.
//
// RETURN TO SOURCE, HONESTLY. A private Telegram chat has no stable deep link, so the row says where it
// is ("in Telegram") rather than inventing a URL. If a future source provides a stable link, this
// element can render it without changing anything else.
//
// EMPLOYEE-PRIVATE, and drawn with the Loop design system's shared primitives. No new tokens, no CSS.

import { type AiTriageCategory, type TimeView } from '@emgloop/shared';

import type { NeedsYouItem } from '../../../daily-loop/needs-you';
import { Panel } from '../_loop-os/record';

/** The category, in plain words for the person. Presentation only; the vocabulary is the AI task's. */
const CATEGORY_LABELS: Readonly<Record<AiTriageCategory, string>> = {
  REQUEST: 'Request',
  DECISION_NEEDED: 'Decision needed',
  COMMITMENT: 'Commitment',
  DEADLINE: 'Deadline',
  BUSINESS_CHANGE: 'Change',
  PROBLEM: 'Problem',
  FOLLOW_UP: 'Follow-up',
  OTHER: 'Needs you',
  NONE: 'Needs you',
};

function categoryLabel(category: string | null): string {
  return (category && CATEGORY_LABELS[category as AiTriageCategory]) || 'Needs you';
}

/**
 * The employee's own "needs you" items from a background source. Shown only when there is at least one:
 * with nothing to show (or the source not in use), the element renders nothing, so Home stays quiet
 * rather than inventing an empty panel.
 */
export function NeedsYou({ items, time }: { items: readonly NeedsYouItem[]; time: TimeView }) {
  if (items.length === 0) return null;
  return (
    <Panel title="Needs you">
      <div className="loop-yourmail">
        <ul className="loop-yourmail__rows">
          {items.map((item) => (
            <li key={item.id}>
              <div className="loop-yourmail__row" data-needs-you-provider={item.provider}>
                <span className="loop-yourmail__who">
                  <span className="loop-yourmail__name">{item.title}</span>
                  <span className="loop-yourmail__why">
                    {item.sourceLabel} · in {item.sourceLabel} · {time.relative(item.at)}
                  </span>
                </span>
                <span className="loop-pill loop-pill--neutral loop-mx__pill">{categoryLabel(item.category)}</span>
              </div>
            </li>
          ))}
        </ul>
        <p className="loop-home__line muted">
          Flagged by AI from your connected sources — a minimized note, never the message. Open the
          conversation in the app it came from to act.
        </p>
      </div>
    </Panel>
  );
}
