// Sprint 30 — Executive Workspace: My Work becomes the operational center.
//
// Admin-only surface (requireWorkspace('ADMIN') via loadWorkDashboard) — serves
// the owner/admin workspace.
//
// Sprint 30 changes two things:
//
//   ORDER. The queues are laid out the way an owner triages: work that has NO
//   owner first (nobody is coming; it is the owner's call), then work of theirs
//   that is blocked, then their own queue, then the day's output. Sprint 24's
//   order led with the reader's own next action and buried the unowned work at
//   position three — the one bucket only the owner can clear.
//
//   LANGUAGE. This page rendered in .loop-* while the workspace home rendered
//   in .wh-*, so two surfaces one click apart looked like different products.
//   Both now use .wh-*. No new CSS file, no new tokens, no new visual language.
//
// What is NOT here — no "Overdue" (no due date exists in the schema) and no
// "Awaiting approval" (approval is a blueprint-template flag that never reaches
// a WorkStage). See work-data.ts for the full reasoning.

import Link from 'next/link';
import { SidebarIcon } from '../../../crm/_brand/SidebarIcon';

import { loadWorkDashboard, type QueueRow } from './work-data';
import {
  completeCurrentStageAction,
  markNotificationReadAction,
} from './actions';

export const dynamic = 'force-dynamic';

function relTime(d: Date): string {
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const days = Math.round(h / 24);
  return days === 1 ? 'yesterday' : days + 'd ago';
}

/** A queue section. `empty` always answers "what should I do next?". */
function Queue({
  title, scope, rows, tag, tagClass, cta, empty,
}: {
  title: string;
  scope: string;
  rows: QueueRow[];
  tag: string;
  tagClass: string;
  cta: string;
  empty: { line: string; next: string };
}) {
  return (
    <section className="wh-card" aria-label={title}>
      <div className="wh-card__head">
        <h2 className="wh-card__title">
          {title}
          {rows.length > 0 ? <span className="wh-count">{rows.length}</span> : null}
        </h2>
        <span className="wh-card__scope">{scope}</span>
      </div>
      {rows.length === 0 ? (
        <div className="wh-emptyblock">
          <p className="wh-empty">{empty.line}</p>
          <p className="wh-empty__next">{empty.next}</p>
        </div>
      ) : (
        <ul className="wh-list">
          {rows.map((r) => (
            <li key={r.workStageId} className="wh-work">
              <div className="wh-work__main">
                <Link href={r.href} className="wh-work__title">{r.title}</Link>
                <div className="wh-work__meta">
                  <span className={'wh-tag ' + tagClass}>{tag}</span>
                  <span className="wh-work__stage">{r.stageName}</span>
                  <span className="wh-work__dot" aria-hidden="true">·</span>
                  <span className="wh-work__assigned">{r.meta}</span>
                </div>
              </div>
              <Link href={r.href} className="wh-btn wh-btn--ghost wh-btn--sm">{cta}</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function WorkOSPage() {
  const {
    actor, nextAction, needsOwner, blocked, assigned, completedToday,
    notifications, unreadCount, hasBlueprints,
  } = await loadWorkDashboard();

  return (
    <div className="loop-os wh wh--dense">
      <div className="wh__main">

        <header className="wh-header">
          <p className="wh-header__greeting">My Work</p>
          <div className="wh-header__meta">
            <span>Execution across {actor.name || actor.email}{'’'}s organization — unowned work first.</span>
          </div>
        </header>

        {/* NEXT ACTION — one step, completable from here */}
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
                Nothing is ready for you right now.
              </span>
            )}
          </div>
          {nextAction ? (
            <div className="wh-next__actions">
              <Link href={nextAction.href} className="wh-btn wh-btn--ghost">Open</Link>
              <form action={completeCurrentStageAction}>
                <input type="hidden" name="workInstanceId" value={nextAction.workInstanceId} />
                <button type="submit" className="wh-btn wh-btn--primary">Complete stage</button>
              </form>
            </div>
          ) : (
            <Link
              href={hasBlueprints ? '/app/admin/work/new' : '/app/admin/work/blueprints/new'}
              className="wh-btn wh-btn--primary"
            >
              {hasBlueprints ? 'Create work' : 'Create a blueprint'}
            </Link>
          )}
        </section>

        {/* 1. NEEDS AN OWNER — nobody is coming; the owner's decision */}
        <Queue
          title="Needs an Owner"
          scope="Longest waiting first"
          rows={needsOwner}
          tag="Unassigned"
          tagClass="wh-tag--pending"
          cta="Assign"
          empty={{
            line: 'Every ready stage has an owner.',
            next: 'Work appears here when a stage becomes ready with nobody assigned — only you can clear it.',
          }}
        />

        {/* 2. BLOCKED — mine, but gated behind someone else */}
        <Queue
          title="Blocked"
          scope="Waiting on an earlier step"
          rows={blocked}
          tag="Blocked"
          tagClass="wh-tag--pending"
          cta="Open"
          empty={{
            line: 'None of your work is blocked.',
            next: 'A stage lands here when you own it but someone else has to finish theirs first.',
          }}
        />

        {/* 3. ASSIGNED TO ME — ready first, then longest waiting */}
        <Queue
          title="Assigned to Me"
          scope="Ready first, then longest waiting"
          rows={assigned}
          tag="Mine"
          tagClass="wh-tag--ready"
          cta="Open"
          empty={{
            line: 'No active work is assigned to you.',
            next: hasBlueprints
              ? 'Create work from a blueprint to put a process in motion.'
              : 'Create a blueprint first — it is the template every work item runs from.',
          }}
        />

        {/* 4. WHAT MOVED TODAY — the whole team's output, not just mine */}
        <Queue
          title="Completed Today"
          scope="Across your organization"
          rows={completedToday}
          tag="Done"
          tagClass="wh-tag--done"
          cta="Review"
          empty={{
            line: 'Nothing has been completed today.',
            next: 'Finished stages are recorded here as your team works through their queues.',
          }}
        />

        <section className="wh-card wh-notes" aria-label="Notifications">
          <div className="wh-card__head">
            <h2 className="wh-card__title">
              Notifications
              {unreadCount > 0 ? <span className="wh-count">{unreadCount}</span> : null}
            </h2>
          </div>
          {notifications.length === 0 ? (
            <div className="wh-emptyblock">
              <p className="wh-empty">You{'’'}re all caught up.</p>
              <p className="wh-empty__next">
                Loop tells you here when a stage becomes yours or a colleague finishes theirs.
              </p>
            </div>
          ) : (
            <ul className="wh-list">
              {notifications.slice(0, 8).map((n) => (
                <li key={n.id} className="wh-note">
                  <div className="wh-note__body">
                    <span className="wh-note__title">{n.title}</span>
                    <span className="wh-note__text">{n.body}</span>
                    <span className="wh-note__time">{relTime(n.createdAt)}</span>
                  </div>
                  {!n.readAt ? (
                    <form action={markNotificationReadAction}>
                      <input type="hidden" name="notificationId" value={n.id} />
                      <button type="submit" className="wh-note__read" aria-label="Mark read">Mark read</button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="wh-card wh-quick" aria-label="Work setup">
          <div className="wh-card__head">
            <h2 className="wh-card__title">Set Up Work</h2>
          </div>
          <div className="wh-quick__grid">
            <Link href="/app/admin/work/new" className="wh-quick__tile">
              <span className="wh-quick__icon"><SidebarIcon name="flow" size={16} /></span>
              <span className="wh-quick__label">New work instance</span>
            </Link>
            <Link href="/app/admin/work/blueprints" className="wh-quick__tile">
              <span className="wh-quick__icon"><SidebarIcon name="columns" size={16} /></span>
              <span className="wh-quick__label">Blueprints</span>
            </Link>
          </div>
        </section>

      </div>
    </div>
  );
}
