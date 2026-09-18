// YOUR MAIL on Home -- what needs the employee, what they are waiting on, and what changed (GM-3).
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §5.2, §12, §19.
//
// EVERY LINE IS ARITHMETIC OVER HEADERS. "Ben replied and you have not answered" is which way the
// newest message went and how long ago. "Ben is unhappy about pricing" is a claim about content,
// which Stage 1 cannot make and therefore does not. Each row carries WHY IT IS HERE, in the same
// words the rule used, so a person can disagree with it specifically.
//
// AND DISAGREEING IS A FIRST-CLASS ACTION. Handled, Waiting on them, Snooze and Dismiss sit beside
// every row. They record a correction; they never edit the evidence that produced the row.
//
// Drawn with the Loop design system's primitives and its existing Home classes.

import Link from 'next/link';

import { productLabel, type TimeView } from '@emgloop/shared';

import { dismissItemAction, markHandledAction, markWaitingOnThemAction, snoozeItemAction } from '../../../daily-loop/mail-actions';
import type { MailAttentionItem, MailAttentionView } from '../../../daily-loop/mail-attention';
import { Panel } from '../_loop-os/record';

// The governed word for this state, imported rather than re-typed: one vocabulary, one place
// (product-language.ts). A component that spells a product state itself is how "Needs your
// attention" becomes three different phrases on three screens.
const NEEDS_ATTENTION = productLabel('NEEDS_ATTENTION')!.label;

/** Why this row is here, in the rule's own terms. No adjective Loop cannot defend. */
function because(item: MailAttentionItem, time: TimeView): string {
  const when = item.lastMessageAt ? time.relative(item.lastMessageAt) : 'at an unknown time';
  switch (item.rule) {
    case 'INBOUND_UNREAD':
      return `They wrote ${when} and it is unread.`;
    case 'INBOUND_UNANSWERED':
      return `They wrote ${when} and you have not replied.`;
    case 'OUTBOUND_UNANSWERED':
      return `You wrote ${when} and there has been no reply.`;
    case 'EXCHANGE_SILENT':
      return `This conversation last moved ${when}.`;
    default:
      return `Last message ${when}.`;
  }
}

function Row({ item, time, waiting }: { item: MailAttentionItem; time: TimeView; waiting?: boolean }) {
  return (
    <li className="loop-attend__item">
      <div className="loop-attend__text">
        <Link href={`/app/mail/${encodeURIComponent(item.threadId)}`} className="loop-attend__title">
          {item.title?.trim() || 'No subject'}
        </Link>
        <p className="loop-attend__why muted">{because(item, time)}</p>
      </div>
      <div className="loop-attend__acts">
        <Link href={`/app/mail/${encodeURIComponent(item.threadId)}`} className="loop-btn loop-btn--quiet">
          Open
        </Link>
        <form action={markHandledAction}>
          <input type="hidden" name="itemId" value={item.id} />
          <button type="submit" className="loop-btn loop-btn--quiet">
            Handled
          </button>
        </form>
        {waiting ? null : (
          <form action={markWaitingOnThemAction}>
            <input type="hidden" name="itemId" value={item.id} />
            <input type="hidden" name="threadId" value={item.threadId} />
            <button type="submit" className="loop-btn loop-btn--quiet">
              I’m waiting on them
            </button>
          </form>
        )}
        <form action={snoozeItemAction}>
          <input type="hidden" name="itemId" value={item.id} />
          <input type="hidden" name="hours" value="24" />
          <button type="submit" className="loop-btn loop-btn--quiet">
            Snooze a day
          </button>
        </form>
        <form action={dismissItemAction}>
          <input type="hidden" name="itemId" value={item.id} />
          <button type="submit" className="loop-btn loop-btn--quiet">
            Dismiss
          </button>
        </form>
      </div>
    </li>
  );
}

/** What changed, as counts. A number here traces to rows; there is no narrative and no adjective. */
function changedLine(view: MailAttentionView, time: TimeView): string {
  const s = view.summary;
  if (s.moved === 0) return `Nothing has moved since ${time.relative(view.since)}.`;
  const parts = [`${s.moved} ${s.moved === 1 ? 'conversation' : 'conversations'} moved`];
  if (s.replies > 0) parts.push(`${s.replies} ${s.replies === 1 ? 'reply' : 'replies'} arrived`);
  if (s.answered > 0) parts.push(`you answered ${s.answered}`);
  return `${parts.join(', ')}.`;
}

export function YourMail({ view, time, unavailable }: { view: MailAttentionView | null; time: TimeView; unavailable?: string | null }) {
  if (!view) {
    return unavailable ? (
      <Panel title="Your mail">
        <p className="loop-home__line muted">{unavailable}</p>
      </Panel>
    ) : null;
  }

  const { needsYou, waitingOnThem, goneQuiet } = view;
  const nothing = needsYou.length === 0 && waitingOnThem.length === 0 && goneQuiet.length === 0;

  return (
    <Panel title="Your mail" lead={changedLine(view, time)}>
      <div className="loop-attend">
        {nothing ? (
          <p className="loop-home__line muted">
            Nothing in your mail is waiting on you or on anybody else. <Link href="/app/mail">Open your inbox</Link>.
          </p>
        ) : null}

        {needsYou.length > 0 ? (
          <section className="loop-attend__group" aria-label={NEEDS_ATTENTION}>
            <h3 className="loop-eyebrow">{NEEDS_ATTENTION}</h3>
            <ul className="loop-attend__list">
              {needsYou.slice(0, 5).map((item) => (
                <Row key={item.id} item={item} time={time} />
              ))}
            </ul>
            {needsYou.length > 5 ? <p className="loop-home__more">and {needsYou.length - 5} more in your inbox.</p> : null}
          </section>
        ) : null}

        {waitingOnThem.length > 0 ? (
          <section className="loop-attend__group" aria-label="Waiting on someone else">
            <h3 className="loop-eyebrow">Waiting on someone else</h3>
            <ul className="loop-attend__list">
              {waitingOnThem.slice(0, 4).map((item) => (
                <Row key={item.id} item={item} time={time} waiting />
              ))}
            </ul>
          </section>
        ) : null}

        {goneQuiet.length > 0 ? (
          <section className="loop-attend__group" aria-label="Gone quiet">
            <h3 className="loop-eyebrow">Gone quiet</h3>
            <ul className="loop-attend__list">
              {goneQuiet.slice(0, 3).map((item) => (
                <Row key={item.id} item={item} time={time} waiting />
              ))}
            </ul>
          </section>
        ) : null}

        <p className="loop-home__line muted">
          <Link href="/app/mail">Open your inbox</Link> — {view.summary.needsYou} needing you, {view.summary.waitingOnThem} waiting on
          somebody else.
        </p>
      </div>
    </Panel>
  );
}
