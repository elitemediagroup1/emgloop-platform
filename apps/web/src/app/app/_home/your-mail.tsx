// YOUR MAIL on Home -- a few truly useful alerts, not a second inbox.
//
// Mail is the operating surface; Home says only how much needs the employee and the few
// conversations that matter most, then points to Mail. The counts and rows come from the SAME read
// model as the Mail dashboard (`loadMailDashboard`), so the two pages can never disagree, and every
// row says why it is there in the rule's own terms. Corrections (Handled, Snooze, Dismiss, "I'm
// waiting on them") live on the conversation itself, not as a wall of buttons here.
//
// IT SAYS HOW CURRENT IT IS, and never calls a queue empty from a read it could not make.

import Link from 'next/link';

import { mailViewRows, type TimeView } from '@emgloop/shared';

import type { MailDashboard, MailDashboardRow } from '../../../daily-loop/mail-dashboard';
import { counterpartName, laneLine, opportunityLine, rowPill } from '../mail/_mail/dashboard';
import { Panel } from '../_loop-os/record';

/**
 * The few conversations Home shows: needs-reply first, then follow-ups, then opportunities.
 * `exclude` holds conversations Home already shows elsewhere, so nothing on the page appears twice.
 */
export function homeMailRows(
  dashboard: MailDashboard,
  limit = 3,
  exclude: ReadonlySet<string> = new Set(),
): { row: MailDashboardRow; context: 'lane' | 'opportunity' }[] {
  const insights = dashboard.rows.map((r) => r.insight);
  const byId = new Map(dashboard.rows.map((r) => [r.insight.threadId, r]));
  const pick = (view: 'needs-reply' | 'follow-ups' | 'opportunities') =>
    mailViewRows(insights, { view, query: '', unreadOnly: false, includeNotifications: false }).map((i) => byId.get(i.threadId)!);
  const out: { row: MailDashboardRow; context: 'lane' | 'opportunity' }[] = [];
  const seen = new Set<string>();
  for (const [view, context] of [['needs-reply', 'lane'], ['follow-ups', 'lane'], ['opportunities', 'opportunity']] as const) {
    for (const row of pick(view)) {
      if (out.length >= limit) return out;
      if (seen.has(row.insight.threadId) || exclude.has(row.insight.threadId)) continue;
      seen.add(row.insight.threadId);
      out.push({ row, context });
    }
  }
  return out;
}

export function YourMail({
  dashboard,
  time,
  currency,
  exclude,
}: {
  dashboard: MailDashboard | null;
  time: TimeView;
  /** How current Loop is about this mailbox, in the Inbox's own words (`mailCurrency`). */
  currency?: { readonly line: string; readonly href?: string; readonly action?: string } | null;
  /** Conversations already on the page (the executive Home's Needs attention). */
  exclude?: ReadonlySet<string>;
}) {
  if (!dashboard) {
    // Nothing Loop can conclude from: say why, and where to fix it. No connection at all, no panel.
    return currency ? (
      <Panel title="Your mail">
        <p className="loop-home__line muted">
          {currency.line}
          {currency.href && currency.action ? (
            <>
              {' '}
              <Link href={currency.href}>{currency.action}</Link>.
            </>
          ) : null}
        </p>
      </Panel>
    ) : null;
  }

  const { summary, current } = dashboard;
  const rows = dashboard.concludable ? homeMailRows(dashboard, 3, exclude) : [];
  const counts: readonly [string, number, string][] = [
    ['Needs reply', summary.needsReply, '/app/mail?view=needs-reply'],
    ['Follow-ups due', summary.followUps, '/app/mail?view=follow-ups'],
    ['New opportunities', summary.opportunities, '/app/mail?view=opportunities'],
  ];

  return (
    <Panel title="Your mail">
      <div className="loop-yourmail">
        {currency ? <p className="loop-home__line muted">{currency.line}</p> : null}
        {!dashboard.concludable ? null : (
          <>
            <ul className="loop-yourmail__counts">
              {counts.map(([label, n, href]) => (
                <li key={label}>
                  <Link href={href} className="loop-yourmail__count">
                    <span className="loop-yourmail__n">{n.toLocaleString('en-US')}</span>
                    <span className="loop-yourmail__label">{label}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {rows.length === 0 ? (
              <p className="loop-home__line muted">
                {exclude && exclude.size > 0
                  ? 'The conversations that need you are listed on this page.'
                  : current
                    ? 'Nothing in your mail needs you right now.'
                    : 'Nothing in your mail needed you when Loop last read it.'}
              </p>
            ) : (
              <ul className="loop-yourmail__rows">
                {rows.map(({ row, context }) => {
                  const pill = rowPill(row.insight, context);
                  return (
                    <li key={row.insight.threadId}>
                      <Link href={`/app/mail/${encodeURIComponent(row.insight.threadId)}`} className="loop-yourmail__row">
                        <span className="loop-yourmail__who">
                          <span className="loop-yourmail__name">{counterpartName(row)}</span>
                          <span className="loop-yourmail__why">
                            {row.insight.subject?.trim() || 'No subject'} ·{' '}
                            {context === 'opportunity' ? opportunityLine(row.insight, time) : laneLine(row.insight, time)}
                          </span>
                        </span>
                        {pill ? <span className={`loop-pill loop-pill--${pill.tone} loop-mx__pill`}>{pill.label}</span> : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
        <Link href="/app/mail" className="loop-link">
          Open Mail →
        </Link>
      </div>
    </Panel>
  );
}
