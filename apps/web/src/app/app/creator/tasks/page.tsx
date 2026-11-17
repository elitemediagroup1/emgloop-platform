import { markTeamReplyRead } from '../../../../creator/creator-hub-actions';
import { CreatorQuestionForm } from '../../../../creator/creator-question-form';
import { CreatorTeam } from '../../../../creator/creator-team';
import { creatorHubRepository } from '../../../../creator/creator-hub-runtime';
import { loadCreatorBrandUpdates,groupCreatorBrandRows,latestCreatorBrandUpdate } from '../../../../creator/creator-brand-updates';
import { creatorPriorities } from '../../../../creator/creator-priorities';
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
  const workTasks = await creatorDomain().records.tasks(seat.actor, {
    content: CREATOR_HREFS.contentRecord,
    profile: CREATOR_HREFS.profile,
  });
  const brands=await loadCreatorBrandUpdates(seat,time);
  const tasks=creatorPriorities(workTasks,groupCreatorBrandRows(brands.rows).flatMap(g=>{const update=latestCreatorBrandUpdate(g);return update?[{id:g.brandId,brand:g.brand,update}]:[];}),time.now);
  const messages=await creatorHubRepository().messages(seat.actor);
  const alerts=await creatorHubRepository().alerts(seat.actor);
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
        {selected ? <aside className="ch-task-detail">
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
        </aside> : null}
      </div>
      <section id="team" className="ch-team-inbox" aria-label="Messages with EMG">
        <CreatorTeam seat={seat}/>
        <h2>Your conversation with EMG</h2>
        {alerts.length?<div className="ch-success" role="status"><strong>{alerts.length} unread {alerts.length===1?'reply':'replies'} from EMG</strong>{alerts.map(a=><form key={a.id} action={markTeamReplyRead}><input type="hidden" name="id" value={a.id}/><a href={`#message-${a.workInstanceId}`}>Read reply →</a> <button className="loop-btn">Mark read</button></form>)}</div>:null}
        {searchParams.message==='sent'?<p className="ch-success" role="status">Your message is saved for EMG. Replies will appear here.</p>:searchParams.message==='unavailable'?<p role="alert">Your message was not saved. Check the message and try again; the daily limit is ten new questions.</p>:null}
        <CreatorQuestionForm/>
        {messages.map(m=><article className="loop-panel" key={m.id} id={`message-${m.id}`}><span className="ch-eyebrow">{m.status==='completed'?'Answered':'With EMG'}</span><h3>{m.title}</h3><p>{m.body}</p><small>{time.dateTime(m.at)}</small>{m.replies.map(reply=><div className="ch-team-reply" key={reply.id}><strong>{reply.fromCreator?'You':'EMG'}</strong><p>{reply.body}</p><small>{time.dateTime(reply.at)}</small></div>)}</article>)}
      </section>
      <section id="updates" aria-label="Your updates">
        <Panel title="Updates">
          <p className="loop-note">
            Content edit notifications appear here. Partnership decisions are included in your priorities above; replies from EMG appear in your conversation.
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
