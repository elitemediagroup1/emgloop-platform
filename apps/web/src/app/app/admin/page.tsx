import Link from 'next/link';
import { SidebarIcon } from '../../crm/_brand/SidebarIcon';
import {
  loadWorkspaceHome,
  parseWorkFilter,
  type WorkFilter,
} from './workspace-home-data';
import { markHomeNotificationReadAction } from './workspace-home-actions';

// Sprint 25 — Executive Operating System (/app/admin).
//
// Same canonical route, shell, navigation and visual language as Sprint 24.
// This file only changes CONTENT + FUNCTION so the page operates the business:
// an executive summary line, a compact Next Action, clickable work buckets that
// filter My Work (via ?filter=), actionable Business Intake, newest CRM
// entities, color-categorized activity, and a self-hiding Getting Started.
// Presentation only: no Prisma, no demo store, no fabricated metrics.

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

const SUMMARY_FILTERS: { key: WorkFilter; label: string }[] = [
  { key: 'assigned', label: 'Assigned to Me' },
  { key: 'ready', label: 'Ready Now' },
  { key: 'blocked', label: 'Waiting / Blocked' },
  { key: 'completed', label: 'Completed Today' },
];

interface PageProps {
  searchParams?: { filter?: string };
}

export default async function WorkspaceHome({ searchParams }: PageProps) {
  const activeFilter = parseWorkFilter(searchParams?.filter);
  const data = await loadWorkspaceHome(activeFilter);
  const {
    header, executiveSummary, nextAction, workSummary, myWork,
    notifications, intake, crm, recentActivity, quickActions, gettingStarted,
  } = data;

  const summaryValues: Record<WorkFilter, number> = {
    assigned: workSummary.assignedToMe,
    ready: workSummary.readyNow,
    blocked: workSummary.waitingBlocked,
    completed: workSummary.completedToday,
  };

  const emptyForFilter: Record<WorkFilter, string> = {
    assigned: 'You currently have no assigned work.',
    ready: 'Nothing is ready for you right now.',
    blocked: 'Nothing is waiting on an earlier step.',
    completed: 'You have not completed any work today.',
  };

  return (
    <div className="loop-os wh wh--dense">
      <div className="wh__main">

        {/* A. HEADER + executive summary */}
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

        {/* B. NEXT ACTION — compact */}
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
                You{'\u2019'}re caught up. No action is waiting on you.
              </span>
            )}
          </div>
          {nextAction ? (
            <Link href={nextAction.href} className="wh-btn wh-btn--primary">{nextAction.verb}</Link>
          ) : null}
        </section>

        {/* C. WORK SUMMARY — clickable buckets that filter My Work below */}
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

        {/* D + E. My Work (main) + Notifications (rail) */}
        <div className="wh-row wh-row--work">
          {/* D. MY WORK */}
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
                <p className="wh-empty">{emptyForFilter[data.activeFilter]}</p>
                {data.activeFilter === 'assigned' ? (
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

          {/* E. NOTIFICATIONS */}
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
              <div className="wh-empty">No new notifications.</div>
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

        {/* F + G. Business Intake + CRM Overview */}
        <div className="wh-row wh-row--half">
          {/* F. BUSINESS INTAKE — actionable, admin/owner/manager only */}
          {data.isAdmin ? (
            <section className="wh-card" aria-label="Business intake">
              <div className="wh-card__head">
                <h2 className="wh-card__title">Business Intake</h2>
              </div>
              <ul className="wh-intake">
                {intake.map((it) => (
                  <li key={it.key} className="wh-intake__row">
                    <div className="wh-intake__text">
                      <span className="wh-intake__label">{it.label}</span>
                      {it.empty ? (
                        <span className="wh-intake__empty">{it.emptyLabel}</span>
                      ) : (
                        <>
                          <span className="wh-intake__title">{it.primaryTitle}</span>
                          {it.primaryDetail ? (
                            <span className="wh-intake__detail">{it.primaryDetail}</span>
                          ) : null}
                        </>
                      )}
                    </div>
                    {it.empty ? null : (
                      <div className="wh-intake__side">
                        {it.count > 1 ? <span className="wh-count">{it.count}</span> : null}
                        <Link href={it.href} className="wh-btn wh-btn--ghost wh-btn--sm">{it.cta}</Link>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <p className="wh-note-line">Access requests are currently delivered by email.</p>
            </section>
          ) : null}

          {/* G. CRM OVERVIEW — newest entities + real counts */}
          <section className="wh-card" aria-label="CRM overview">
            <div className="wh-card__head">
              <h2 className="wh-card__title">CRM Overview</h2>
              <Link href="/crm/customers" className="wh-card__link">Open CRM</Link>
            </div>
            {data.crmTotals.totalCustomers === 0 && data.crmTotals.openConversations === 0 ? (
              <div className="wh-empty">No CRM activity yet.</div>
            ) : (
              <ul className="wh-crm">
                {crm.filter((c) => c.present).map((c) => (
                  <li key={c.key} className="wh-crm__row">
                    <div className="wh-crm__text">
                      <span className="wh-crm__label">{c.label}</span>
                      <span className="wh-crm__title">{c.title}</span>
                      {c.detail ? <span className="wh-crm__detail">{c.detail}</span> : null}
                    </div>
                    <Link href={c.href} className="wh-btn wh-btn--ghost wh-btn--sm">{c.cta}</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* H. RECENT ACTIVITY — color-categorized by event type */}
        <section className="wh-card wh-activity" aria-label="Recent activity">
          <div className="wh-card__head">
            <h2 className="wh-card__title">Recent Activity</h2>
            {data.isAdmin ? <Link href="/crm/audit" className="wh-card__link">View Audit Log</Link> : null}
          </div>
          {recentActivity.length === 0 ? (
            <div className="wh-empty">No recent activity yet.</div>
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

        {/* I. QUICK ACTIONS — Sprint 25 order */}
        <section className="wh-card wh-quick" aria-label="Quick actions">
          <div className="wh-card__head">
            <h2 className="wh-card__title">Quick Actions</h2>
          </div>
          <div className="wh-quick__grid">
            {quickActions.map((q) => (
              <Link key={q.key} href={q.href} className="wh-quick__tile">
                <span className="wh-quick__icon"><SidebarIcon name={q.icon} size={16} /></span>
                <span className="wh-quick__label">{q.label}</span>
              </Link>
            ))}
          </div>
        </section>

        {/* J. GETTING STARTED — disappears entirely once complete */}
        {gettingStarted.show ? (
          <section className="wh-card wh-getstarted" aria-label="Getting started">
            <div className="wh-card__head">
              <h2 className="wh-card__title">Getting Started</h2>
            </div>
            <ul className="wh-check">
              {gettingStarted.items.map((c) => (
                <li key={c.key} className={'wh-check__row' + (c.done ? ' is-done' : '')}>
                  <span className="wh-check__mark" aria-hidden="true">{c.done ? '\u2713' : ''}</span>
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
