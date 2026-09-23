import { requireWorkspace } from '../../../../workspaces/guard';
import { CREATOR_HREFS, creatorDomain, requireCreator } from '../../../../creator/creator-runtime';
import { viewerTime } from '../../../../time/viewer-time';
import { LoopPage, PageHead, Panel, StateBlock } from '../../_loop-os/record';
import { TaskList } from '../_parts/task-list';

// Tasks (Creator Hub): what needs this creator, derived from the rows -- a review step assigned to
// their login, a deliverable without content, a setup step not done. Nothing is a task because a
// page said so; the read model derives each one and points at the record it lives on. There is no
// completed list: Loop keeps the events on the records, not a checklist of its own.

export const dynamic = 'force-dynamic';

export default async function CreatorTasksPage() {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const time = viewerTime();
  const tasks = await creatorDomain().records.tasks(seat.actor, { content: CREATOR_HREFS.contentRecord, profile: CREATOR_HREFS.profile });
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
      <Panel title="Completed">
        <StateBlock kind="unavailable" compact title="Loop does not keep a completed list." body="What you finished lives on each record's history, where it was recorded." />
      </Panel>
    </LoopPage>
  );
}
