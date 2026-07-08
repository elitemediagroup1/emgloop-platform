// PR #75 — Work OS Blueprint Runtime v1
// Work instance detail: title, current stage, all stages in order with owners,
// comments, a Complete-current-stage control (with next-owner selector when
// another stage exists), and stage reassignment.

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireWorkActor, workRepo, listAssignableUsers } from '../work-data';
import {
  completeCurrentStageAction,
  assignStageAction,
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

export default async function WorkDetailPage({ params }: { params: { id: string } }) {
  const actor = await requireWorkActor();
  const work = workRepo();
  const [instance, users] = await Promise.all([
    work.getWorkInstance(params.id),
    listAssignableUsers(actor.organizationId),
  ]);

  if (!instance || instance.organizationId !== actor.organizationId) {
    notFound();
  }

  const current = instance.stages.find((s) => s.id === instance.currentStageId) ?? null;
  const hasNext =
    current != null &&
    instance.stages.some((s) => s.position > current.position && s.status !== 'skipped');

  return (
    <div className="loop-grid">
      <div className="loop-grid__content">
        <div className="loop-pagehead">
          <div className="loop-eyebrow">
            <Link href="/app/admin/work">Work OS</Link> / detail
          </div>
          <h1 className="loop-title">{instance.title}</h1>
          <p className="loop-subtitle">
            Status: {instance.status}
            {current ? ` · Current stage: ${current.name}` : ''}
          </p>
          {instance.description ? (
            <p className="loop-card__hint">{instance.description}</p>
          ) : null}
        </div>

        {/* Complete current stage */}
        {instance.status === 'active' && current ? (
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
              ) : (
                <div className="loop-card__hint">
                  This is the final stage — completing it finishes the work.
                </div>
              )}
              <button className="loop-badge" type="submit">
                Complete stage
              </button>
            </form>
          </section>
        ) : null}

        {/* All stages */}
        <section className="loop-card">
          <div className="loop-card__head">
            <h2 className="loop-card__title">Stages</h2>
          </div>
          <ol className="loop-brief__list">
            {instance.stages.map((s) => (
              <li key={s.id}>
                <div className="loop-banner__title">
                  {s.position}. {s.name}{' '}
                  <span className="loop-badge loop-badge--idle">{s.status}</span>
                </div>
                <div className="loop-banner__body">
                  Owner: {ownerName(s.ownerUserId, users)}
                </div>
                {instance.status === 'active' ? (
                  <form action={assignStageAction} className="loop-launchers">
                    <input type="hidden" name="workStageId" value={s.id} />
                    <input type="hidden" name="workInstanceId" value={instance.id} />
                    <select name="userId" defaultValue={s.ownerUserId ?? ''}>
                      <option value="">Unassigned</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name || u.email}
                        </option>
                      ))}
                    </select>
                    <button className="loop-card__hint" type="submit">
                      Save owner
                    </button>
                  </form>
                ) : null}
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
            <textarea name="body" rows={2} placeholder="Add a comment…" />
            <button className="loop-card__hint" type="submit">
              Add comment
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
