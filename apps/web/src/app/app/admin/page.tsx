import Link from 'next/link';
import { SidebarIcon } from '../../crm/_brand/SidebarIcon';
import {
  loadWorkspaceHome,
  parseWorkFilter,
  type WorkFilter,
} from './workspace-home-data';
import { markHomeNotificationReadAction } from './workspace-home-actions';

// Sprint 30 — Executive Workspace (/app/admin).
//
// Same canonical route, shell, navigation and visual language as Sprint 25.
// This file changes STRUCTURE: the page is now grouped by the three questions
// an owner opens Loop to answer, instead of by feature area.
//
//   1. Needs attention today  — concrete decisions, oldest neglected first.
//   2. What happens next      — the next action, then my work.
//   3. What happened recently — activity + what got finished today.
//
// Sprint 25 rendered ten sections. Four are gone, and each removal has a reason:
//   - Quick Actions: six tiles that only duplicated the sidebar and the CTA on
//     the very item they referred to. Navigation is not a decision.
//   - CRM Overview: "Total Customers: 3 / View all" is a vanity count, not
//     something an owner acts on. Its two ACTIONABLE parts (a quiet
//     conversation, an unqualified request) are now attention rows with a
//     reason attached.
//   - Business Intake: its three concerns (invitations, unassigned work, open
//     conversations) were counts grouped by feature; they are now individual
//     decisions ranked against each other by age.
//   - Next Action as its own card: it is the top of My Work, so it lives there.
//
// Presentation only: no Prisma, no demo store, no fabricated metrics. Every
// number and label on this page traces to a row — see workspace-home-data.ts
// for what the schema cannot support (due dates, approvals) and why we do not
// pretend otherwise.

export const dynamic = 'force-dynamic';

function relTime(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  return d + 'd ago';
}

const NOTE_ICON: Record<string, string> = {
  next_action_ready: 'flow',
  assigned: 'team',
  completed: 'activity',
  approval_needed: 'cog',
};

const ACTIVITY_ICON: Record<string, string> = {
  work: 'flow',
  customer: 'users',
  invitation: 'team',
  auth: 'activity',
  system: 'cog',
};

const ATTENTION_ICON: Record<string, string> = {
  work: 'flow',
  conversation: 'chat',
  request: 'users',
  invitation: 'team',
};

const SUMMARY_FILTERS: { key: WorkFilter; label: string }[] = [
  { key: 'assigned', label: 'Assigned to Me' },
  { key: 'ready', label: 'Ready Now' },
  { key: 'blocked', label: 'Waiting / Blocked' },
  { key: 'completed', label: 'Completed Today' },
];

// Every empty state answers "what should I do next?" — never a bare "No data."
const EMPTY_FOR_FILTER: Record<WorkFilter, { line: string; next: string }> = {
  assigned: {
    line: 'No work is assigned to you.',
    next: 'Create work from a blueprint to put a process in motion.',
  },
  ready: {
    line: 'Nothing is ready for you right now.',
    next: 'Ready work appears here the moment a colleague finishes the step before yours.',
  },
  blocked: {
    line: 'Nothing of yours is waiting on an earlier step.',
    next: 'Work lands here when you own a stage that someone else has to reach first.',
  },
  completed: {
    line: 'You have not completed any work today.',
    next: 'Finish a stage in My Work and it will be recorded here.',
  },
};

interface PageProps {
  searchParams?: { filter?: string };
}

export default async function WorkspaceHome({ searchParams }: PageProps) {
  const activeFilter = parseWorkFilter(searchParams?.filter);
  const data = await loadWorkspaceHome(activeFilter);
  const {
    header, executiveSummary, attention, attentionTotal, nextAction, workSummary,
    myWork, notifications, recentActivity, completedTodayCount, gettingStarted,
  } = data;

  const summaryValues: Record<WorkFilter, number> = {
    assigned: workSummary.assignedToMe,
    ready: workSummary.readyNow,
    blocked: workSummary.waitingBlocked,
    completed: workSummary.completedToday,
  };

  const empty = EMPTY_FOR_FILTER[activeFilter];
  const moreAttention = attentionTotal - attention.length;

  return (
    <div className="loop-os wh wh--dense">
      <div className="wh__main">

        {/* HEADER — who, where, and the state of the business in one line */}
        <header className="wh-header">
          <p className="wh-header__greeting">{header.greeting}, {header.displayName}.</p>
          <div className="wh-header__meta">
            <span className="wh-header__org">{header.organizationName}</span>
            <span className="wh-header__dot" aria-hidden="true">·</span>
            <span>{header.dateLabel}</span>
            <span className="wh-header__dot" aria-hidden="true">·</span>
            <span className="wh-header__role">{header.roleLabel}</span>
          </div>
          {executiveSummary.length > 0 ? (
            <p className="wh-summline">
              {executiveSummary.map((line, i) => (
                <span key={i} className="wh-summline__part">{line}</span>
              ))}
            </p>
          ) : null}
        </header>

        {/* 1. NEEDS ATTENTION TODAY — the decisions, oldest neglected first */}
        <section className="wh-card wh-att" aria-label="Needs attention today">
          <div className="wh-card__head">
            <h2 className="wh-card__title">
              Needs Attention Today
              {attentionTotal > 0 ? <span className="wh-count">{attentionTotal}</span> : null}
            </h2>
            <span className="wh-card__scope">Longest waiting first</span>
          </div>
          {attention.length === 0 ? (
            <div className="wh-emptyblock">
              <p className="wh-empty">Nothing needs a decision from you right now.</p>
              <p className="wh-empty__next">
                Work without an owner, conversations that go quiet, unqualified service
                requests and unaccepted invitations all surface here as they happen.
              </p>
            </div>
          ) : (
            <ul className="wh-list">
              {attention.map((a) => (
                <li key={a.key} className="wh-work">
                  <span className={'wh-att__icon wh-att__icon--' + a.kind} aria-hidden="true">
                    <SidebarIcon name={ATTENTION_ICON[a.kind] ?? 'activity'} size={14} />
                  </span>
                  <div className="wh-work__main">
                    <Link href={a.href} className="wh-work__title">{a.title}</Link>
                    <div className="wh-work__meta">
                      <span className="wh-att__kind">{a.kindLabel}</span>
                      <span className="wh-work__dot" aria-hidden="true">·</span>
                      <span className="wh-work__assigned">{a.reason}</span>
                    </div>
                  </div>
                  <Link href={a.href} className="wh-btn wh-btn--ghost wh-btn--sm">{a.cta}</Link>
                </li>
              ))}
            </ul>
          )}
          {moreAttention > 0 ? (
            <p className="wh-note-line">
              {moreAttention} more {moreAttention === 1 ? 'item is' : 'items are'} waiting behind these.
            </p>
          ) : null}
        </section>

        {/* 2. WHAT HAPPENS NEXT — next action, then my work */}
        <section className="wh-card wh-next wh-next--compact" aria-label="Next action">
          <div className="wh-next__lead">
            <span className="wh-next__eyebrow">Next Action</span>
            {nextAction ? (
              <>
                <span className="wh-next__title">{nextAction.title}</span>
                <span className="wh-next__stage">
                  <SidebarIcon name="flow" size={13} /> {nextAction.stageName}
                </span>
              </>
            ) : (
              <span className="wh-next__title wh-next__title--calm">
                You{'’'}re caught up. No action is waiting on you.
              </span>
            )}
          </div>
          {nextAction ? (
            <Link href={nextAction.href} className="wh-btn wh-btn--primary">{nextAction.verb}</Link>
          ) : null}
        </section>

        <section className="wh-summary" aria-label="My work summary">
          {SUMMARY_FILTERS.map((f) => {
            const active = data.activeFilter === f.key;
            const href = f.key === 'assigned' ? '/app/admin' : '/app/admin?filter=' + f.key;
            return (
              <Link
                key={f.key}
                href={href}
                scroll={false}
                className={'wh-summary__card' + (active ? ' is-active' : '')}
                aria-current={active ? 'true' : undefined}
              >
                <span className="wh-summary__value">{summaryValues[f.key]}</span>
                <span className="wh-summary__label">{f.label}</span>
              </Link>
            );
          })}
        </section>

        <div className="wh-row wh-row--work">
          <section className="wh-card wh-mywork" aria-label="My work">
            <div className="wh-card__head">
              <h2 className="wh-card__title">
                My Work
                <span className="wh-card__scope">{SUMMARY_FILTERS.find((f) => f.key === data.activeFilter)?.label}</span>
              </h2>
              <Link href="/app/admin/work" className="wh-card__link">View All My Work</Link>
            </div>
            {myWork.length === 0 ? (
              <div className="wh-emptyblock">
                <p className="wh-empty">{empty.line}</p>
                <p className="wh-empty__next">{empty.next}</p>
                {activeFilter === 'assigned' && data.canCreateWork ? (
                  <Link href="/app/admin/work/new" className="wh-btn wh-btn--primary wh-btn--sm">Create Work</Link>
                ) : null}
              </div>
            ) : (
              <ul className="wh-list">
                {myWork.map((w) => (
                  <li key={w.workInstanceId} className="wh-work">
                    <div className="wh-work__main">
                      <Link href={w.href} className="wh-work__title">{w.title}</Link>
                      <div className="wh-work__meta">
                        <span className={'wh-tag wh-tag--' + (w.status === 'ready' ? 'ready' : w.status === 'in_progress' ? 'progress' : w.status === 'completed' ? 'done' : 'pending')}>
                          {w.status === 'ready' ? 'Ready' : w.status === 'in_progress' ? 'In progress' : w.status === 'completed' ? 'Completed' : 'Blocked'}
                        </span>
                        <span className="wh-work__stage">{w.stageName}</span>
                        <span className="wh-work__dot" aria-hidden="true">·</span>
                        <span className="wh-work__assigned">{w.assignedLabel}</span>
                      </div>
                    </div>
                    <Link href={w.href} className="wh-btn wh-btn--ghost wh-btn--sm">{w.verb}</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="wh-card wh-notes" aria-label="Notifications">
            <div className="wh-card__head">
              <h2 className="wh-card__title">
                Notifications
                {notifications.unreadCount > 0 ? (
                  <span className="wh-count">{notifications.unreadCount}</span>
                ) : null}
              </h2>
            </div>
            {notifications.items.length === 0 ? (
              <div className="wh-emptyblock">
                <p className="wh-empty">You{'’'}re all caught up.</p>
                <p className="wh-empty__next">
                  Loop tells you here when a stage becomes yours or a colleague finishes theirs.
                </p>
              </div>
            ) : (
              <ul className="wh-list">
                {notifications.items.map((n) => (
                  <li key={n.id} className="wh-note">
                    <span className={'wh-note__icon wh-note__icon--' + n.kind}>
                      <SidebarIcon name={NOTE_ICON[n.kind] ?? 'activity'} size={14} />
                    </span>
                    <div className="wh-note__body">
                      {n.href ? (
                        <Link href={n.href} className="wh-note__title">{n.title}</Link>
                      ) : (
                        <span className="wh-note__title">{n.title}</span>
                      )}
                      <span className="wh-note__text">{n.body}</span>
                      <span className="wh-note__time">{relTime(n.createdAtIso)}</span>
                    </div>
                    <form action={markHomeNotificationReadAction}>
                      <input type="hidden" name="notificationId" value={n.id} />
                      <button type="submit" className="wh-note__read" aria-label="Mark read">Mark read</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* 3. WHAT HAPPENED RECENTLY */}
        <section className="wh-card wh-activity" aria-label="Recent activity">
          <div className="wh-card__head">
            <h2 className="wh-card__title">
              What Happened Recently
              <span className="wh-card__scope">
                {completedTodayCount === 0
                  ? 'Nothing finished today'
                  : completedTodayCount + (completedTodayCount === 1 ? ' work item finished today' : ' work items finished today')}
              </span>
            </h2>
            {data.canViewAudit ? <Link href="/crm/audit" className="wh-card__link">View Audit Log</Link> : null}
          </div>
          {recentActivity.length === 0 ? (
            <div className="wh-emptyblock">
              <p className="wh-empty">Nothing has happened here yet.</p>
              <p className="wh-empty__next">
                Every recorded action — work created, customers added, people invited — appears
                here as your team starts operating.
              </p>
            </div>
          ) : (
            <ul className="wh-feed">
              {recentActivity.map((a) => (
                <li key={a.id} className="wh-feed__item">
                  <span className={'wh-feed__icon wh-feed__icon--' + a.category}>
                    <SidebarIcon name={ACTIVITY_ICON[a.category] ?? 'cog'} size={13} />
                  </span>
                  <span className="wh-feed__label">{a.label}</span>
                  <span className="wh-feed__actor">{a.actorName}</span>
                  <span className="wh-feed__time">{relTime(a.createdAtIso)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* GETTING STARTED — disappears entirely once complete */}
        {gettingStarted.show ? (
          <section className="wh-card wh-getstarted" aria-label="Getting started">
            <div className="wh-card__head">
              <h2 className="wh-card__title">Getting Started</h2>
            </div>
            <ul className="wh-check">
              {gettingStarted.items.map((c) => (
                <li key={c.key} className={'wh-check__row' + (c.done ? ' is-done' : '')}>
                  <span className="wh-check__mark" aria-hidden="true">{c.done ? '✓' : ''}</span>
                  <span className="wh-check__label">{c.label}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

      </div>
    </div>
  );
}
