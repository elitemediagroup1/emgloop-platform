// PR #76 — Employee Work Queue
// Work instance detail for employees: title, current stage, the full ordered
// stage list with owners, comments, and — only when the CURRENT stage is
// assigned to the signed-in employee — a Complete-current-stage control with a
// next-owner selector when another stage exists. Organization isolation is
// enforced before anything renders. Reuses the PR #75 WorkRepository runtime.

import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  requireEmployeeActor,
  loadEmployeeInstance,
  listAssignableUsers,
} from '../work-data';
import {
  completeCurrentStageAction,
  addWorkCommentAction,
} from '../actions';

export const dynamic = 'force-dynamic';

function ownerName(
  userId: string | null,
  users: { id: string; name: string | null; email: string }[],
): string {
  if (!userId) return 'Unassigned';
  const u = users.find((x) => x.id === userId);
  return u ? u.name || u.email : userId;
}

export default async function EmployeeWorkDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const actor = await requireEmployeeActor();
  const [instance, users] = await Promise.all([
    loadEmployeeInstance(params.id, actor.organizationId),
    listAssignableUsers(actor.organizationId),
  ]);

  if (!instance) {
    notFound();
  }

  const current =
    instance.stages.find((s) => s.id === instance.currentStageId) ?? null;
  const isMine = current ? current.ownerUserId === actor.userId : false;
  const hasNext =
    current !== null &&
    instance.stages.some(
      (s) => s.position > current.position && s.status !== 'skipped',
    );

  return (
    <div className="loop-grid">
      <div className="loop-grid__content">
        <div className="loop-pagehead">
          <div className="loop-eyebrow">
            <Link href="/app/employee/work">My Work</Link> / detail
          </div>
          <h1 className="loop-title">{instance.title}</h1>
          <p className="loop-subtitle">
            {current ? `Current stage: ${current.name}` : 'No active stage.'}
          </p>
        </div>

        {/* Complete current stage — only when it is assigned to me */}
        {instance.status === 'active' && current && isMine ? (
          <section className="loop-card">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Complete current stage</h2>
              <span className="loop-card__hint">{current.name}</span>
            </div>
            <form action={completeCurrentStageAction} className="loop-brief__list">
              <input type="hidden" name="workInstanceId" value={instance.id} />
              {hasNext ? (
                <label>
                  <div className="loop-card__hint">Next owner</div>
                  <select name="nextOwnerUserId">
                    <option value="">Keep copied default / leave unassigned</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name || u.email}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <button className="loop-badge" type="submit">
                Complete stage
              </button>
            </form>
          </section>
        ) : (
          <section className="loop-card">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Current stage</h2>
              <span className="loop-card__hint">
                {current ? current.name : 'None'}
              </span>
            </div>
            <div className="loop-empty">
              <div className="loop-empty__body">
                {current
                  ? `Owned by ${ownerName(current.ownerUserId, users)} — nothing for you to do yet.`
                  : 'This work has no active stage.'}
              </div>
            </div>
          </section>
        )}

        {/* All stages in order */}
        <section className="loop-card">
          <div className="loop-card__head">
            <h2 className="loop-card__title">Stages</h2>
            <span className="loop-card__hint">{instance.stages.length}</span>
          </div>
          <ol className="loop-brief__list">
            {instance.stages.map((s) => (
              <li key={s.id}>
                <div className="loop-banner__title">
                  {s.position}. {s.name}
                </div>
                <div className="loop-banner__body">
                  {s.status} · {ownerName(s.ownerUserId, users)}
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Comments */}
        <section className="loop-card loop-feed">
          <div className="loop-card__head">
            <h2 className="loop-card__title">Comments</h2>
            <span className="loop-card__hint">{instance.comments.length}</span>
          </div>
          {instance.comments.length === 0 ? (
            <div className="loop-empty">
              <div className="loop-empty__body">No comments yet.</div>
            </div>
          ) : (
            <ul className="loop-brief__list">
              {instance.comments.map((c) => (
                <li key={c.id}>
                  <div className="loop-banner__body">
                    {ownerName(c.userId, users)}: {c.body}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <form action={addWorkCommentAction} className="loop-brief__list">
            <input type="hidden" name="workInstanceId" value={instance.id} />
            <input name="body" placeholder="Add a comment" />
            <button className="loop-card__hint" type="submit">
              Comment
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
