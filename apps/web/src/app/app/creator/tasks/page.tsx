import { requireWorkspace } from '../../../../workspaces/guard';
import { CREATOR_HREFS, creatorDomain, requireCreator } from '../../../../creator/creator-runtime';
import { viewerTime } from '../../../../time/viewer-time';
import { LoopPage, PageHead, Panel, StateBlock } from '../../_loop-os/record';
import { markCreatorUpdateReadAction } from '../../../../creator/creator-actions';
import { TaskList } from '../_parts/task-list';

// Tasks (Creator Hub): what needs this creator, derived from the rows -- a review step assigned to
// their login, a deliverable without content, a setup step not done. Nothing is a task because a
// page said so; the read model derives each one and points at the record it lives on. There is no
// completed list: Loop keeps the events on the records, not a checklist of its own.
// Updates reuse private, creator-scoped Work OS notifications; no email or push is sent.

export const dynamic = 'force-dynamic';

export default async function CreatorTasksPage() {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const time = viewerTime();
  const tasks = await creatorDomain().records.tasks(seat.actor, { content: CREATOR_HREFS.contentRecord, profile: CREATOR_HREFS.profile });
  const updates = await creatorDomain().records.updates(seat.actor);
  const needs = tasks.filter((t) => t.bucket === 'NEEDS_ATTENTION');
  const upcoming = tasks.filter((t) => t.bucket === 'UPCOMING');

  return (
    <LoopPage label="Tasks">
      <PageHead trail={[{ label: 'Creator' }, { label: 'Tasks' }]} title="Tasks" subtitle="Derived from your records: a returned edit waiting on you, a deliverable without content, a setup step." />
      <Panel title="Needs attention">
        {needs.length === 0 ? <StateBlock kind="empty" compact title="Nothing needs you right now." body="A returned edit or a deliverable due within three days lands here." /> : <TaskList tasks={needs} time={time} />}
      </Panel>
      <Panel title="Upcoming">
        {upcoming.length === 0 ? <StateBlock kind="empty" compact title="Nothing upcoming." body="Deliverables with a later due date and setup steps appear here." /> : <TaskList tasks={upcoming} time={time} />}
      </Panel>
      <section id="updates" aria-label="Your updates">
        <Panel title="Updates">
          <p className="loop-note">Edit-return updates in Loop. Your notification preference controls this list; review tasks remain above.</p>
          {updates.length === 0 ? <StateBlock kind="empty" compact title="No edit-return updates to show." body="Updates appear when EMG returns your content for review and in-app updates are enabled in your profile." /> : (
            <ul className="ch-list">
              {updates.map(update => <li className="ch-row" key={update.id}>
                <a className="ch-row__main" href={CREATOR_HREFS.contentRecord(update.contentId)}>
                  <span className="ch-row__title">{update.title} · {update.contentTitle}</span>
                  <span className="loop-note">{time.date(update.at)} · {update.readAt ? 'Read' : 'Unread'}</span>
                </a>
                {!update.readAt ? <form action={markCreatorUpdateReadAction}>
                  <input type="hidden" name="notificationId" value={update.id} />
                  <button type="submit" className="loop-btn">Mark read</button>
                </form> : null}
              </li>)}
            </ul>
          )}
        </Panel>
      </section>
      <Panel title="Completed">
        <StateBlock kind="unavailable" compact title="Loop does not keep a completed list." body="What you finished lives on each record's history, where it was recorded." />
      </Panel>
    </LoopPage>
  );
}
