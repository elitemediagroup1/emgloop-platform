// PR #76 — Employee Work Queue
// Employee-facing Work OS homepage. Shows ONLY real work assigned to the
// signed-in employee: their next action, active queue, work waiting on others,
// what they completed today, and their in-app notifications. Reuses the PR #75
// WorkRepository runtime via server-only helpers. No blueprint creation is
// exposed here — that stays admin-only.

import Link from 'next/link';

import { loadEmployeeWork } from './work-data';
import {
  completeCurrentStageAction,
  markNotificationReadAction,
} from './actions';

export const dynamic = 'force-dynamic';

function StageLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="loop-brief">
      <strong>{label}:</strong> {value}
    </div>
  );
}

export default async function EmployeeWorkPage() {
  const { actor, nextAction, myQueue, waiting, completedToday, notifications } =
    await loadEmployeeWork();

  const unread = notifications.filter((n) => !n.readAt);

  return (
    <div className="loop-grid">
      <div className="loop-grid__content">
        <div className="loop-pagehead">
          <div className="loop-eyebrow">My Work</div>
          <h1 className="loop-title">Work queue</h1>
          <p className="loop-subtitle">
            Your assigned work, one stage at a time. Finish your step and the next
            owner is notified automatically.
          </p>
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
              <Link className="loop-card__hint" href={`/app/employee/work/${nextAction.instance.id}`}>
                Open work
              </Link>
            </div>
          ) : (
            <div className="loop-empty">
              <div className="loop-empty__title">Nothing is waiting on you.</div>
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
              <div className="loop-empty__title">You have no work assigned.</div>
              <div className="loop-empty__body">
                Work assigned to you will appear here.
              </div>
            </div>
          ) : (
            <ul className="loop-brief__list">
              {myQueue.map((w) => (
                <li key={w.id}>
                  <Link href={`/app/employee/work/${w.id}`}>{w.title}</Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Waiting / blocked */}
        <section className="loop-card">
          <div className="loop-card__head">
            <h2 className="loop-card__title">Waiting / blocked</h2>
            <span className="loop-card__hint">{waiting.length}</span>
          </div>
          {waiting.length === 0 ? (
            <div className="loop-empty">
              <div className="loop-empty__body">Nothing is waiting on someone else.</div>
            </div>
          ) : (
            <ul className="loop-brief__list">
              {waiting.map((w) => (
                <li key={w.id}>
                  <Link href={`/app/employee/work/${w.id}`}>{w.title}</Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Completed today */}
        <section className="loop-card">
          <div className="loop-card__head">
            <h2 className="loop-card__title">Completed today</h2>
            <span className="loop-card__hint">{completedToday.length}</span>
          </div>
          {completedToday.length === 0 ? (
            <div className="loop-empty">
              <div className="loop-empty__title">You're all caught up.</div>
              <div className="loop-empty__body">
                Stages you finish today will show here.
              </div>
            </div>
          ) : (
            <ul className="loop-brief__list">
              {completedToday.map((w) => (
                <li key={w.id}>
                  <Link href={`/app/employee/work/${w.id}`}>{w.title}</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Notification center */}
      <aside className="loop-rail">
        <div className="loop-card loop-feed">
          <div className="loop-card__head">
            <h2 className="loop-card__title">Notifications</h2>
            <span className="loop-card__hint">{unread.length} unread</span>
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
                  {!n.readAt ? (
                    <form action={markNotificationReadAction}>
                      <input type="hidden" name="notificationId" value={n.id} />
                      <button className="loop-card__hint" type="submit">
                        Mark read
                      </button>
                    </form>
                  ) : null}
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
