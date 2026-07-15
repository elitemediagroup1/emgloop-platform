import Link from 'next/link';
import { SidebarIcon } from '../../crm/_brand/SidebarIcon';
import { loadWorkspaceHome } from './workspace-home-data';
import { markHomeNotificationReadAction } from './workspace-home-actions';

// Sprint 24 — Canonical Workspace Home (/app/admin).
//
// The single post-login dashboard for OWNER / ADMIN / MANAGER, rendered inside
// the existing ADMIN WorkspaceShell (layout.tsx already guards + wraps). All
// data comes from loadWorkspaceHome(), which is session-scoped and truthful.
// This file is presentation only: no Prisma, no demo store, no fabricated
// metrics, no hardcoded person or organization.

export const dynamic = 'force-dynamic';

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  return d + 'd ago';
}

export default async function WorkspaceHome() {
  const data = await loadWorkspaceHome();
  const { header, nextAction, workSummary, myWork, notifications, intake, crm, recentActivity, quickActions, gettingStarted } = data;

  const summaryCards = [
    { key: 'assigned', label: 'Assigned to Me', value: workSummary.assignedToMe },
    { key: 'ready', label: 'Ready Now', value: workSummary.readyNow },
    { key: 'waiting', label: 'Waiting / Blocked', value: workSummary.waitingBlocked },
    { key: 'completed', label: 'Completed Today', value: workSummary.completedToday },
  ];

  return (
    <div className="loop-os wh">
      <div className="wh__main">

        {/* A. HEADER */}
        <header className="wh-header">
          <div>
            <p className="wh-header__greeting">{header.greeting}, {header.displayName}.</p>
            <div className="wh-header__meta">
              <span className="wh-header__org">{header.organizationName}</span>
              <span className="wh-header__dot" aria-hidden="true">·</span>
              <span>{header.dateLabel}</span>
              <span className="wh-header__dot" aria-hidden="true">·</span>
              <span className="wh-header__role">{header.roleLabel}</span>
            </div>
          </div>
        </header>

        {/* B. NEXT ACTION */}
        <section className="wh-card wh-next" aria-label="Next action">
          <div className="wh-card__head">
            <h2 className="wh-card__title">Next Action</h2>
          </div>
          {nextAction ? (
            <div className="wh-next__body">
              <div className="wh-next__info">
                <div className="wh-next__title">{nextAction.title}</div>
                <div className="wh-next__stage">
                  <SidebarIcon name="flow" size={13} /> {nextAction.stageName}
                </div>
              </div>
              <Link href={nextAction.href} className="wh-btn wh-btn--primary">Open Work</Link>
            </div>
          ) : (
            <div className="wh-empty">You{'\u2019'}re caught up. No action is waiting on you.</div>
          )}
        </section>

        {/* C. MY WORK SUMMARY */}
        <section className="wh-summary" aria-label="My work summary">
          {summaryCards.map((c) => (
            <div key={c.key} className="wh-summary__card">
              <div className="wh-summary__value">{c.value}</div>
              <div className="wh-summary__label">{c.label}</div>
            </div>
          ))}
        </section>

        {/* D + E. TWO COLUMN: My Work (~65%) + Notifications (~35%) */}
        <div className="wh-row wh-row--work">
          {/* D. MY WORK */}
          <section className="wh-card wh-mywork" aria-label="My work">
            <div className="wh-card__head">
              <h2 className="wh-card__title">My Work</h2>
              <Link href="/app/admin/work" className="wh-card__link">View All My Work</Link>
            </div>
            {myWork.length === 0 ? (
              <div className="wh-empty">You have no assigned work.</div>
            ) : (
              <ul className="wh-list">
                {myWork.map((w) => (
                  <li key={w.workInstanceId} className="wh-list__row">
                    <Link href={w.href} className="wh-list__main">
                      <span className="wh-list__title">{w.title}</span>
                      <span className="wh-list__sub">{w.stageName}</span>
                    </Link>
                    <span className={'wh-tag wh-tag--' + (w.status === 'ready' ? 'ready' : 'progress')}>
                      {w.status === 'ready' ? 'Ready' : 'In progress'}
                    </span>
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
                      <button type="submit" className="wh-note__read" aria-label="Mark read">
                        Mark read
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* F + G. TWO COLUMN: Business Intake (50%) + CRM Overview (50%) */}
        <div className="wh-row wh-row--half">
          {/* F. BUSINESS INTAKE — admin/owner/manager only */}
          {data.isAdmin ? (
            <section className="wh-card" aria-label="Business intake">
              <div className="wh-card__head">
                <h2 className="wh-card__title">Business Intake</h2>
              </div>
              {intake.length === 0 ? (
                <div className="wh-empty">Nothing needs review.</div>
              ) : (
                <div className="wh-metrics">
                  {intake.map((c) => (
                    <Link key={c.key} href={c.href} className="wh-metric">
                      <span className="wh-metric__value">{c.count}</span>
                      <span className="wh-metric__label">{c.label}</span>
                    </Link>
                  ))}
                </div>
              )}
              <p className="wh-note-line">Access requests are currently delivered by email.</p>
            </section>
          ) : null}

          {/* G. CRM OVERVIEW */}
          <section className="wh-card" aria-label="CRM overview">
            <div className="wh-card__head">
              <h2 className="wh-card__title">CRM Overview</h2>
            </div>
            {crm.every((c) => c.count === 0) ? (
              <div className="wh-empty">No CRM activity yet.</div>
            ) : (
              <div className="wh-metrics">
                {crm.map((c) => (
                  <Link key={c.key} href={c.href} className="wh-metric">
                    <span className="wh-metric__value">{c.count}</span>
                    <span className="wh-metric__label">{c.label}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* H. RECENT ACTIVITY (full width) */}
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
                  <span className="wh-feed__dot" aria-hidden="true" />
                  <span className="wh-feed__label">{a.label}</span>
                  <span className="wh-feed__actor">{a.actorName}</span>
                  <span className="wh-feed__time">{relTime(a.createdAtIso)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* I. QUICK ACTIONS */}
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

        {/* J. GETTING STARTED — only while org is still early-stage */}
        {gettingStarted.show ? (
          <section className="wh-card wh-getstarted" aria-label="Getting started">
            <div className="wh-card__head">
              <h2 className="wh-card__title">Getting Started</h2>
            </div>
            <ul className="wh-check">
              {gettingStarted.items.map((c) => (
                <li key={c.key} className={'wh-check__row' + (c.done ? ' is-done' : '')}>
                  <span className="wh-check__mark" aria-hidden="true">
                    {c.done ? '\u2713' : ''}
                  </span>
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
