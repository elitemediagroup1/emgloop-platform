// The Mail dashboard -- email intelligence for what matters, not another inbox.
//
// Every number, name and word below comes from the read model (`loadMailDashboard`): a lane is a
// rule, an opportunity is a named signal, an area is a matched word, and each row says why it is
// there. Nothing here is a sample, and nothing here reads a message body -- a row's second line is
// the rule's reason, because Loop stores no preview of anybody's mail.
//
// EVERY ROW OPENS THE EXISTING CONVERSATION (`/app/mail/[threadId]`), scoped by the same principal:
// the thread, the reply, Draft with Loop and Send are unchanged, and the only way mail leaves.
//
// Server components only; the filters are links and a GET form, so they work without JavaScript.

import Link from 'next/link';

import type { MailInsight, MailSummary, MailViewKey, TimeView } from '@emgloop/shared';

import { SidebarIcon } from '../../../crm/_brand/SidebarIcon';
import type { MailDashboardRow } from '../../../../daily-loop/mail-dashboard';

// --- The filter, as a URL ---------------------------------------------------------------------------

export interface MailFilterState {
  readonly view: MailViewKey;
  readonly query: string;
  readonly unreadOnly: boolean;
  readonly includeNotifications: boolean;
}

/** The URL for a view, keeping the search and the filters. Nothing here names a person. */
export function mailHref(state: MailFilterState, over: Partial<MailFilterState> = {}): string {
  const s = { ...state, ...over };
  const params = new URLSearchParams();
  if (s.view !== 'dashboard') params.set('view', s.view);
  if (s.query.trim() !== '') params.set('q', s.query.trim());
  if (s.unreadOnly) params.set('unread', '1');
  if (s.includeNotifications) params.set('notifications', '1');
  const qs = params.toString();
  return qs ? `/app/mail?${qs}` : '/app/mail';
}

// --- Words ----------------------------------------------------------------------------------------

/** Why a conversation is in its lane, in the rule's own terms. */
export function laneLine(insight: MailInsight, time: TimeView): string {
  const when = insight.laneAt ? time.relative(insight.laneAt) : 'at an unknown time';
  switch (insight.laneReason) {
    case 'UNREAD_INBOUND':
      return `They wrote ${when} · unread`;
    case 'INBOUND_UNANSWERED':
      return `They wrote ${when} and you have not replied`;
    case 'OUTREACH_REPLY_UNANSWERED':
      return `They replied to your outreach ${when}`;
    case 'AWAITING_RESPONSE':
      return `You wrote ${when} · awaiting their response`;
    case 'MARKED_WAITING':
      return 'You said you are waiting on them';
    case 'OUTREACH_NO_RESPONSE':
      return `Last outreach ${when} · no response`;
    case 'NO_RESPONSE_SINCE':
      return `You wrote last ${when} · no response since`;
    default:
      return insight.lastMessageAt ? `Last message ${time.relative(insight.lastMessageAt)}` : 'No messages Loop can date';
  }
}

export function opportunityLine(insight: MailInsight, time: TimeView): string {
  const o = insight.opportunity;
  if (!o) return '';
  return o.kind === 'OUTREACH_REPLY'
    ? `Replied to your outreach ${time.relative(o.at)}`
    : `New inbound conversation · subject mentions “${o.matched}”`;
}

type PillTone = 'critical' | 'attention' | 'good' | 'info' | 'neutral';

/** The status word for a row, in the context it is shown. Each one is a rule's outcome. */
export function rowPill(insight: MailInsight, context: 'lane' | 'opportunity' | 'any'): { label: string; tone: PillTone } | null {
  if (context === 'opportunity' || (context === 'any' && !insight.lane && insight.opportunity)) {
    if (!insight.opportunity) return null;
    return insight.opportunity.kind === 'OUTREACH_REPLY' ? { label: 'Outreach reply', tone: 'good' } : { label: 'Opportunity', tone: 'good' };
  }
  switch (insight.lane) {
    case 'NEEDS_REPLY':
      return { label: 'Needs reply', tone: 'critical' };
    case 'FOLLOW_UP':
      return { label: 'Follow up', tone: 'info' };
    case 'WAITING':
      return { label: 'Waiting', tone: 'attention' };
    default:
      return null;
  }
}

/** Who a conversation is with, the way a person would name them. */
export function counterpartName(row: MailDashboardRow): string {
  const c = row.insight.counterpart;
  if (c?.name?.trim()) return c.name.trim();
  if (c?.address) return c.address;
  const p = row.thread.people[0];
  return p?.name?.trim() || p?.address || 'Unknown sender';
}

/** Two initials and a stable tone, from the name alone. No remote image is ever fetched. */
function Avatar({ name }: { name: string }) {
  const letters = name
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={`loop-mx__avatar loop-mx__avatar--${hash % 5}`} aria-hidden="true">
      {letters || '?'}
    </span>
  );
}

// --- A row ------------------------------------------------------------------------------------------

export function ConversationRow({ row, time, context }: { row: MailDashboardRow; time: TimeView; context: 'lane' | 'opportunity' | 'any' }) {
  const { insight, thread } = row;
  const name = counterpartName(row);
  const pill = rowPill(insight, context);
  const detail = context === 'opportunity' ? opportunityLine(insight, time) : insight.lane ? laneLine(insight, time) : insight.opportunity ? opportunityLine(insight, time) : laneLine(insight, time);
  const at = context === 'opportunity' && insight.opportunity ? insight.opportunity.at : insight.lastMessageAt;
  return (
    <li className="loop-mx__item">
      <Link href={`/app/mail/${encodeURIComponent(insight.threadId)}`} className={'loop-mx__row' + (insight.unread ? ' loop-mx__row--unread' : '')}>
        <Avatar name={name} />
        <span className="loop-mx__who">
          <span className="loop-mx__name">{name}</span>
          {insight.counterpart?.domain ? <span className="loop-mx__company">{insight.counterpart.domain}</span> : null}
        </span>
        <span className="loop-mx__topic">
          <span className="loop-mx__subject">{insight.subject?.trim() || 'No subject'}</span>
          <span className="loop-mx__detail">{detail}</span>
        </span>
        {at ? (
          <time className="loop-mx__when" dateTime={time.iso(at)}>
            {time.relative(at)}
          </time>
        ) : (
          <span className="loop-mx__when" />
        )}
        <span className="loop-mx__tags">
          {pill ? <span className={`loop-pill loop-pill--${pill.tone} loop-mx__pill`}>{pill.label}</span> : null}
          {thread.hasDraft ? <span className="loop-mail__tag">Draft</span> : null}
          {thread.sendUnconfirmed ? <span className="loop-mail__tag loop-mail__tag--attention">Delivery unconfirmed</span> : null}
        </span>
        <span className="loop-mx__chevron" aria-hidden="true">
          <SidebarIcon name="chevron" size={16} />
        </span>
      </Link>
    </li>
  );
}

// --- The cards ----------------------------------------------------------------------------------------

const CARDS: readonly {
  readonly key: 'needsReply' | 'followUps' | 'waiting' | 'opportunities';
  readonly view: MailViewKey;
  readonly label: string;
  readonly icon: string;
  readonly tone: 'crit' | 'accent' | 'warn' | 'good';
  readonly inflow: (n: number) => string;
}[] = [
  { key: 'needsReply', view: 'needs-reply', label: 'Need my reply', icon: 'mail', tone: 'crit', inflow: (n) => `${n} arrived in the last day` },
  { key: 'followUps', view: 'follow-ups', label: 'Follow-ups due', icon: 'send', tone: 'accent', inflow: (n) => `${n} became due in the last day` },
  { key: 'waiting', view: 'waiting', label: 'Waiting on them', icon: 'clock', tone: 'warn', inflow: (n) => `${n} sent in the last day` },
  { key: 'opportunities', view: 'opportunities', label: 'New opportunities', icon: 'target', tone: 'good', inflow: (n) => `${n} in the last day` },
];

export function SummaryCards({ summary, state }: { summary: MailSummary; state: MailFilterState }) {
  return (
    <nav className="loop-mx__cards" aria-label="Mail summary">
      {CARDS.map((card) => {
        const value = summary[card.key];
        const inflow = summary.inflow[card.key];
        return (
          <Link
            key={card.key}
            href={mailHref(state, { view: card.view })}
            className={`loop-mx__card loop-mx__card--${card.tone}` + (state.view === card.view ? ' loop-mx__card--active' : '')}
            aria-current={state.view === card.view ? 'page' : undefined}
          >
            <span className="loop-mx__card-icon" aria-hidden="true">
              <SidebarIcon name={card.icon} size={26} />
            </span>
            <span className="loop-mx__card-body">
              <span className="loop-mx__card-value">{value.toLocaleString('en-US')}</span>
              <span className="loop-mx__card-label">{card.label}</span>
              {inflow > 0 ? <span className="loop-mx__card-delta">↑ {card.inflow(inflow)}</span> : null}
            </span>
            <span className="loop-mx__chevron" aria-hidden="true">
              <SidebarIcon name="chevron" size={18} />
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

// --- The filter bar -------------------------------------------------------------------------------

const PILLS: readonly { readonly view: MailViewKey; readonly label: string; readonly count?: keyof MailSummary }[] = [
  { view: 'dashboard', label: 'All' },
  { view: 'needs-reply', label: 'Needs reply', count: 'needsReply' },
  { view: 'follow-ups', label: 'Follow-ups', count: 'followUps' },
  { view: 'waiting', label: 'Waiting', count: 'waiting' },
  { view: 'opportunities', label: 'Opportunities', count: 'opportunities' },
  { view: 'talent', label: 'Talent', count: 'talent' },
  { view: 'performance', label: 'Performance', count: 'performance' },
  { view: 'operations', label: 'Operations', count: 'operations' },
];

export function FilterBar({ summary, state }: { summary: MailSummary; state: MailFilterState }) {
  const active = (view: MailViewKey) => (view === 'dashboard' ? state.view === 'dashboard' || state.view === 'all' : state.view === view);
  return (
    <div className="loop-mx__bar">
      <nav className="loop-mx__pills" aria-label="Mail views">
        {PILLS.map((p) => {
          const n = p.count ? (summary[p.count] as number) : null;
          return (
            <Link
              key={p.view}
              href={mailHref(state, { view: p.view })}
              className={'loop-mx__filter' + (active(p.view) ? ' loop-mx__filter--on' : '')}
              aria-current={active(p.view) ? 'page' : undefined}
            >
              {p.label}
              {n !== null && n > 0 ? <span className="loop-mx__filter-count">{n}</span> : null}
            </Link>
          );
        })}
      </nav>
      <form className="loop-mx__search" method="get" action="/app/mail" role="search">
        {state.view !== 'dashboard' ? <input type="hidden" name="view" value={state.view} /> : null}
        <label className="loop-mx__search-field">
          <SidebarIcon name="search" size={16} />
          <input
            type="search"
            name="q"
            defaultValue={state.query}
            className="loop-mx__search-input"
            placeholder="Search conversations…"
            aria-label="Search conversations"
          />
        </label>
        <details className="loop-mx__more">
          <summary className="loop-mx__more-button" aria-label="Filters">
            <SidebarIcon name="filter" size={16} />
            <span className="loop-mx__more-label">Filters</span>
          </summary>
          <div className="loop-mx__more-panel">
            <label className="loop-mx__check">
              <input type="checkbox" name="unread" value="1" defaultChecked={state.unreadOnly} /> Unread only
            </label>
            <label className="loop-mx__check">
              <input type="checkbox" name="notifications" value="1" defaultChecked={state.includeNotifications} /> Include notification mail
            </label>
            <button type="submit" className="loop-btn">
              Apply
            </button>
          </div>
        </details>
      </form>
    </div>
  );
}

// --- A lane --------------------------------------------------------------------------------------

export function LaneSection({
  title,
  icon,
  tone,
  rows,
  total,
  href,
  time,
  context,
  empty,
}: {
  title: string;
  icon: string;
  tone: 'crit' | 'accent' | 'warn' | 'good';
  rows: readonly MailDashboardRow[];
  total: number;
  href: string;
  time: TimeView;
  context: 'lane' | 'opportunity';
  empty: string;
}) {
  return (
    <section className="loop-mx__lane" aria-label={title}>
      <header className="loop-mx__lane-head">
        <span className={`loop-mx__lane-icon loop-mx__lane-icon--${tone}`} aria-hidden="true">
          <SidebarIcon name={icon} size={20} />
        </span>
        <h2 className="loop-mx__lane-title">{title}</h2>
        {total > 0 ? (
          <Link href={href} className="loop-mx__viewall">
            View all ({total}) →
          </Link>
        ) : null}
      </header>
      {rows.length === 0 ? (
        <p className="loop-mx__empty">{empty}</p>
      ) : (
        <ul className="loop-mx__list">
          {rows.map((row) => (
            <ConversationRow key={row.insight.threadId} row={row} time={time} context={context} />
          ))}
        </ul>
      )}
    </section>
  );
}

// --- Recent important threads ------------------------------------------------------------------------

export function RecentThreads({ rows, time, href }: { rows: readonly MailDashboardRow[]; time: TimeView; href: string }) {
  if (rows.length === 0) return null;
  return (
    <section className="loop-mx__recent" aria-label="Recent important threads">
      <header className="loop-mx__lane-head">
        <span className="loop-mx__lane-icon loop-mx__lane-icon--accent" aria-hidden="true">
          <SidebarIcon name="activity" size={18} />
        </span>
        <h2 className="loop-mx__lane-title loop-mx__lane-title--small">Recent important threads</h2>
        <Link href={href} className="loop-mx__viewall">
          See more →
        </Link>
      </header>
      <ul className="loop-mx__recent-list">
        {rows.map((row) => {
          const pill = rowPill(row.insight, 'any');
          return (
            <li key={row.insight.threadId}>
              <Link href={`/app/mail/${encodeURIComponent(row.insight.threadId)}`} className="loop-mx__recent-row">
                <span className="loop-mx__recent-who">{counterpartName(row)}</span>
                <span className="loop-mx__recent-subject">{row.insight.subject?.trim() || 'No subject'}</span>
                {pill ? <span className={`loop-pill loop-pill--${pill.tone} loop-mx__pill`}>{pill.label}</span> : <span />}
                {row.insight.lastMessageAt ? (
                  <time className="loop-mx__when" dateTime={time.iso(row.insight.lastMessageAt)}>
                    {time.relative(row.insight.lastMessageAt)}
                  </time>
                ) : (
                  <span />
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The filter a request asked for. It reads four keys -- a view, a search, and two switches -- and
 * nothing else: no key here can name a person, a mailbox or an organization.
 */
export function mailFilterFrom(params: Readonly<Record<string, string | string[] | undefined>> | undefined): MailFilterState {
  const one = (key: string): string => {
    const value = params?.[key];
    return typeof value === 'string' ? value : Array.isArray(value) ? value[0] ?? '' : '';
  };
  const view = one('view');
  return {
    view: (['all', 'needs-reply', 'follow-ups', 'waiting', 'opportunities', 'talent', 'performance', 'operations'] as const).includes(view as never)
      ? (view as MailViewKey)
      : 'dashboard',
    query: one('q').slice(0, 200),
    unreadOnly: one('unread') === '1',
    includeNotifications: one('notifications') === '1',
  };
}

export const VIEW_TITLES: Readonly<Record<MailViewKey, string>> = Object.freeze({
  dashboard: 'All conversations',
  all: 'All conversations',
  'needs-reply': 'Needs my reply',
  'follow-ups': 'Follow-ups due',
  waiting: 'Waiting on them',
  opportunities: 'New opportunities',
  talent: 'Talent',
  performance: 'Performance',
  operations: 'Operations',
});
