import { requireWorkspace } from '../../../../workspaces/guard';
import { CREATOR_HREFS, creatorDomain, requireCreator } from '../../../../creator/creator-runtime';
import { viewerTime } from '../../../../time/viewer-time';
import { LoopPage, Panel, StateBlock } from '../../_loop-os/record';
import { markCreatorUpdateReadAction } from '../../../../creator/creator-actions';
import Link from 'next/link';
import { CreatorPageHead } from '../../../../creator/creator-page-head';

// Tasks (Creator Hub): what needs this creator, derived from the rows -- a review step assigned to
// their login, a deliverable without content, a deliverable needing attention. Nothing is a task because a
// page said so; the read model derives each one and points at the record it lives on. There is no
// completed list: Loop keeps the events on the records, not a checklist of its own.
// Updates reuse private, creator-scoped Work OS notifications; no email or push is sent.

export const dynamic = 'force-dynamic';

export default async function CreatorTasksPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const time = viewerTime();
  const tasks = await creatorDomain().records.tasks(seat.actor, {
    content: CREATOR_HREFS.contentRecord,
    profile: CREATOR_HREFS.profile,
  });
  const updates = await creatorDomain().records.updates(seat.actor);
  const needs = tasks.filter((t) => t.bucket === 'NEEDS_ATTENTION');
  const upcoming = tasks.filter((t) => t.bucket === 'UPCOMING');

  const selectedBucket = searchParams.view === 'upcoming' ? upcoming : needs;
  const selected = selectedBucket.find((t) => t.key === searchParams.task) ?? selectedBucket[0];
  return (
    <LoopPage label="Tasks">
      <CreatorPageHead
        section="Tasks"
        title="Your next move."
        description="Action items for your partnerships and content, in one place."
      />
      <nav className="ch-analytics-tabs" aria-label="Task view">
        <Link
          className="ch-analytics-tab"
          href="/app/creator/tasks"
          aria-current={searchParams.view !== 'upcoming' ? 'page' : undefined}
        >
          Needs you · {needs.length}
        </Link>
        <Link
          className="ch-analytics-tab"
          href="/app/creator/tasks?view=upcoming"
          aria-current={searchParams.view === 'upcoming' ? 'page' : undefined}
        >
          Upcoming · {upcoming.length}
        </Link>
      </nav>
      <div className="ch-task-workspace">
        <section>
          <h2>{searchParams.view === 'upcoming' ? 'Coming up' : 'Your priorities'}</h2>
          {selectedBucket.length ? (
            <ul className="ch-task-index">
              {selectedBucket.map((task) => (
                <li key={task.key}>
                  <Link
                    href={`/app/creator/tasks?view=${searchParams.view === 'upcoming' ? 'upcoming' : 'needs'}&task=${encodeURIComponent(task.key)}`}
                    aria-current={selected?.key === task.key ? 'true' : undefined}
                  >
                    <span className="ch-task-kind">{task.kind.replace(/_/g, ' ')}</span>
                    <strong>{task.title}</strong>
                    <span>{task.dueAt ? time.date(task.dueAt) : 'No due date set'} →</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <StateBlock
              kind="empty"
              compact
              title="Nothing waiting here."
              body="Your tasks appear as work is assigned or your content needs review."
            />
          )}
        </section>
        <aside className="ch-task-detail">
          {selected ? (
            <>
              <span className="ch-eyebrow">{selected.kind.replace(/_/g, ' ')}</span>
              <h2>{selected.title}</h2>
              <p>{selected.detail}</p>
              <p className="loop-note">
                {selected.dueAt ? `Due ${time.date(selected.dueAt)}` : 'No due date set'}
              </p>
              <Link className="loop-btn loop-btn--primary" href={selected.href}>
                Open task →
              </Link>
              <p className="loop-note">
                Complete this task on its source record. Progress is recorded there.
              </p>
            </>
          ) : (
            <>
              <h2>Nothing selected.</h2>
              <p>New reviews and deliverables will appear here when they need you.</p>
            </>
          )}
        </aside>
      </div>
      <section id="updates" aria-label="Your updates">
        <Panel title="Updates">
          <p className="loop-note">
            Edit-return updates in Loop. Your notification preference controls this list; review
            tasks remain above.
          </p>
          {updates.length === 0 ? (
            <StateBlock
              kind="empty"
              compact
              title="No edit-return updates to show."
              body="Updates appear when EMG returns your content for review and in-app updates are enabled in your profile."
            />
          ) : (
            <ul className="ch-list">
              {updates.map((update) => (
                <li className="ch-row" key={update.id}>
                  <a className="ch-row__main" href={CREATOR_HREFS.contentRecord(update.contentId)}>
                    <span className="ch-row__title">
                      {update.title} · {update.contentTitle}
                    </span>
                    <span className="loop-note">
                      {time.date(update.at)} · {update.readAt ? 'Read' : 'Unread'}
                    </span>
                  </a>
                  {!update.readAt ? (
                    <form action={markCreatorUpdateReadAction}>
                      <input type="hidden" name="notificationId" value={update.id} />
                      <button type="submit" className="loop-btn">
                        Mark read
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </section>
    </LoopPage>
  );
}
