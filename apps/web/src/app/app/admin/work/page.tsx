// PR #75 — Work OS Blueprint Runtime v1
// Admin Work OS dashboard. Replaces the placeholder shell with a real,
// interactive queue view: Next Action, My Queue, Waiting / Unassigned,
// Completed Today, and Notifications.
//
// Admin-only surface (requireWorkspace('ADMIN') via loadWorkDashboard) — serves
// the owner/admin workspace. An employee-workspace queue is a follow-up PR.

import Link from 'next/link';

import { loadWorkDashboard } from './work-data';
import {
  completeCurrentStageAction,
  markNotificationReadAction,
} from './actions';

export const dynamic = 'force-dynamic';

function StageLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="loop-brief__list">
      <strong>{label}:</strong> {value}
    </div>
  );
}

export default async function WorkOSPage() {
  const { actor, nextAction, myQueue, unassigned, completedToday, notifications } =
    await loadWorkDashboard();

  const unread = notifications.filter((n) => !n.readAt);

  return (
    <div className="loop-grid">
      <div className="loop-grid__content">
        <div className="loop-pagehead">
          <div className="loop-eyebrow">Work OS</div>
          <h1 className="loop-title">Execution</h1>
          <p className="loop-subtitle">
            Create repeatable work from a Blueprint, then move it stage by stage.
            When you finish your step, the next owner is assigned and notified.
          </p>
        </div>

        <div className="loop-card loop-actions">
          <div className="loop-launchers">
            <Link className="loop-badge" href="/app/admin/work/new">
              + New work instance
            </Link>
            <Link className="loop-badge loop-badge--idle" href="/app/admin/work/blueprints">
              Blueprints
            </Link>
          </div>
        </div>

        {/* Next action */}
        <section className="loop-card">
          <div className="loop-card__head">
            <h2 className="loop-card__title">Your next action</h2>
          </div>
          {nextAction ? (
            <div className="loop-brief">
              <StageLine label="Work" value={nextAction.instance.title} />
              <StageLine label="Stage" value={nextAction.stage.name} />
              <form action={completeCurrentStageAction}>
                <input type="hidden" name="workInstanceId" value={nextAction.instance.id} />
                <button className="loop-badge" type="submit">
                  Complete this stage
                </button>
              </form>
              <Link
                className="loop-card__hint"
                href={`/app/admin/work/${nextAction.instance.id}`}
              >
                Open work detail →
              </Link>
            </div>
          ) : (
            <div className="loop-empty">
              <div className="loop-empty__title">Nothing waiting on you</div>
              <div className="loop-empty__body">
                You have no stage that is ready for you right now.
              </div>
            </div>
          )}
        </section>

        {/* My queue */}
        <section className="loop-card">
          <div className="loop-card__head">
            <h2 className="loop-card__title">My queue</h2>
            <span className="loop-card__hint">{myQueue.length} active</span>
          </div>
          {myQueue.length === 0 ? (
            <div className="loop-empty">
              <div className="loop-empty__body">No active work assigned to you.</div>
            </div>
          ) : (
            <ul className="loop-brief__list">
              {myQueue.map((w) => (
                <li key={w.id}>
                  <Link href={`/app/admin/work/${w.id}`}>{w.title}</Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Waiting / unassigned */}
        <section className="loop-card">
          <div className="loop-card__head">
            <h2 className="loop-card__title">Waiting / Unassigned</h2>
            <span className="loop-card__hint">{unassigned.length} need an owner</span>
          </div>
          {unassigned.length === 0 ? (
            <div className="loop-empty">
              <div className="loop-empty__body">Every ready stage has an owner.</div>
            </div>
          ) : (
            <ul className="loop-brief__list">
              {unassigned.map((s) => (
                <li key={s.id}>
                  <span className="loop-badge loop-badge--idle">Needs owner</span>{' '}
                  <Link href={`/app/admin/work/${s.workInstanceId}`}>
                    {s.workInstance.title} — {s.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Completed today */}
        <section className="loop-card loop-feed">
          <div className="loop-card__head">
            <h2 className="loop-card__title">Completed today</h2>
            <span className="loop-card__hint">{completedToday.length}</span>
          </div>
          {completedToday.length === 0 ? (
            <div className="loop-empty">
              <div className="loop-empty__body">Nothing completed yet today.</div>
            </div>
          ) : (
            <ul className="loop-brief__list">
              {completedToday.map((w) => (
                <li key={w.id}>{w.title}</li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Notifications rail */}
      <aside className="loop-rail">
        <div className="loop-card loop-brief">
          <div className="loop-card__head">
            <h2 className="loop-card__title">Notifications</h2>
            <span className="loop-badge loop-badge--idle">{unread.length} new</span>
          </div>
          {notifications.length === 0 ? (
            <div className="loop-empty">
              <div className="loop-empty__body">No notifications yet.</div>
            </div>
          ) : (
            <ul className="loop-brief__list">
              {notifications.map((n) => (
                <li key={n.id}>
                  <div className="loop-banner__title">{n.title}</div>
                  <div className="loop-banner__body">{n.body}</div>
                  {!n.readAt && (
                    <form action={markNotificationReadAction}>
                      <input type="hidden" name="notificationId" value={n.id} />
                      <button className="loop-card__hint" type="submit">
                        Mark read
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="loop-card__hint">Signed in as {actor.name || actor.email}</div>
      </aside>
    </div>
  );
}
