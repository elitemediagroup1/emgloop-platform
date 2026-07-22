// Work detail — the canonical EMG Loop drill-down (EntityPage).
//
// A WorkInstance is a single entity, so it renders through the permanent
// storytelling pattern: who/what it is, whether it is healthy, what changed,
// why it matters, what should happen next (the completable step), the evidence
// (every stage's real state), and what happened previously (the timeline). The
// interactive controls — complete the current step, reassign owners, comment —
// are passed into the pattern's primaryAction / manage slots, so the story
// stays identical to every other drill-down in Loop.
//
// No implementation vocabulary on screen: "stage/status/currentStageId" become
// "step", "Ready/Waiting/Completed", and plain English.

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireWorkActor, workRepo, listAssignableUsers } from '../work-data';
import {
  completeCurrentStageAction,
  assignStageAction,
  addWorkCommentAction,
} from '../actions';
import {
  EntityPage,
  type EntityPageModel,
  type EntityTone,
  type EntityStat,
  type EntityChange,
  type EntityEvidence,
  type EntityHistoryItem,
  type EntityRelatedItem,
} from '../../../_loop-os';

export const dynamic = 'force-dynamic';

function relTime(d: Date | null): string {
  if (!d) return '';
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const days = Math.round(h / 24);
  return days === 1 ? 'yesterday' : days + 'd ago';
}

function ownerName(
  userId: string | null,
  users: { id: string; name: string | null; email: string }[],
): string {
  if (!userId) return 'Unassigned';
  const u = users.find((x) => x.id === userId);
  return u ? u.name || u.email : 'Someone';
}

// Implementation status -> the word a human reads.
function stepWord(status: string): string {
  if (status === 'completed') return 'Completed';
  if (status === 'ready') return 'Ready';
  if (status === 'in_progress') return 'In progress';
  if (status === 'skipped') return 'Skipped';
  return 'Waiting';
}

function stepTone(status: string): EntityTone {
  if (status === 'completed') return 'good';
  if (status === 'ready' || status === 'in_progress') return 'info';
  return 'idle';
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

  const stages = [...instance.stages].sort((a, b) => a.position - b.position);
  const total = stages.length;
  const completedStages = stages.filter((s) => s.status === 'completed');
  const done = completedStages.length;
  const current = stages.find((s) => s.id === instance.currentStageId) ?? null;
  const hasNext =
    current != null &&
    stages.some((s) => s.position > current.position && s.status !== 'skipped');
  const isComplete = instance.status === 'completed';
  const currentOwner = current ? ownerName(current.ownerUserId, users) : 'Unassigned';

  // 2. Is it healthy?
  let health: EntityPageModel['health'];
  if (isComplete) {
    health = { label: 'Complete', tone: 'good', line: 'This work is finished — every step has been completed.' };
  } else if (!current) {
    health = { label: 'Idle', tone: 'idle', line: 'This work is active but no step is currently in motion.' };
  } else if (current.status === 'ready' && !current.ownerUserId) {
    health = {
      label: 'Needs an owner',
      tone: 'warn',
      line: `The step “${current.name}” is ready, but nobody is assigned to it. Only you can put someone on it.`,
    };
  } else if (current.status === 'pending') {
    health = {
      label: 'Blocked',
      tone: 'warn',
      line: `“${current.name}” can’t start yet — earlier work needs to finish first.`,
    };
  } else {
    health = {
      label: 'On track',
      tone: 'good',
      line: `${currentOwner} is on “${current.name}”. Nothing is stuck.`,
    };
  }

  // Identity facts.
  const stats: EntityStat[] = [
    { label: 'Progress', value: `${done} / ${total} steps`, tone: isComplete ? 'good' : undefined },
    { label: 'Current step', value: current ? current.name : isComplete ? 'None left' : '—' },
    { label: 'Owner', value: current ? currentOwner : '—', tone: current && !current.ownerUserId ? 'warn' : undefined },
    { label: 'Started', value: relTime(new Date(instance.createdAt)) || 'Today' },
  ];

  // 3. What changed — recent step transitions.
  const changes: EntityChange[] = completedStages
    .filter((s) => s.completedAt)
    .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime())
    .slice(0, 3)
    .map((s) => ({
      label: s.name,
      direction: 'up' as const,
      detail: `completed ${relTime(new Date(s.completedAt!))} by ${ownerName(s.completedByUserId, users)}`,
    }));
  if (!isComplete && current && current.status === 'ready') {
    changes.unshift({
      label: current.name,
      direction: 'flat',
      detail: current.ownerUserId ? `is ready for ${currentOwner}` : 'is ready and waiting for an owner',
    });
  }

  // 4. Why it matters.
  const whyItMatters = isComplete
    ? undefined
    : current
      ? hasNext
        ? `Completing “${current.name}” hands the work to the next step and keeps it moving.`
        : `“${current.name}” is the final step — completing it finishes this work.`
      : undefined;

  // 6. Evidence — every step's real state.
  const evidence: EntityEvidence[] = stages.map((s) => ({
    label: `${s.position}. ${s.name} — ${stepWord(s.status)}`,
    tone: stepTone(s.status),
    facts: [
      { statement: 'State', value: stepWord(s.status) },
      { statement: 'Owner', value: ownerName(s.ownerUserId, users) },
      ...(s.startedAt ? [{ statement: 'Started', value: relTime(new Date(s.startedAt)) || 'recently' }] : []),
      ...(s.completedAt
        ? [{ statement: 'Completed', value: relTime(new Date(s.completedAt)) || 'recently', source: `by ${ownerName(s.completedByUserId, users)}` }]
        : []),
    ],
    note: s.description ?? undefined,
  }));

  // 7. What happened previously.
  const history: EntityHistoryItem[] = [
    ...completedStages
      .filter((s) => s.completedAt)
      .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime())
      .map((s) => ({
        label: `${s.name} completed`,
        detail: `by ${ownerName(s.completedByUserId, users)}`,
        at: relTime(new Date(s.completedAt!)),
        tone: 'good' as EntityTone,
      })),
    { label: 'Work created', at: relTime(new Date(instance.createdAt)) || 'Today', tone: 'info' as EntityTone },
  ];

  // 7. Related — where to go from here.
  const related: EntityRelatedItem[] = [
    { icon: 'flow', title: 'All work', detail: 'Every work item across your organization', href: '/app/admin/work' },
    { icon: 'grid', title: 'Home', detail: 'What needs your attention today', href: '/app/admin' },
  ];

  // 5. The completable step (interactive primary action).
  const primaryAction =
    !isComplete && current ? (
      <form action={completeCurrentStageAction} className="ent-manage">
        <input type="hidden" name="workInstanceId" value={instance.id} />
        <div className="ent-action__main">
          <span className="ent-action__title">Complete “{current.name}”</span>
          <p className="ent-action__why">
            {hasNext
              ? 'Marking this step done hands the work to the next step.'
              : 'This is the final step — completing it finishes the work.'}
          </p>
        </div>
        {hasNext ? (
          <label className="ent-field">
            <span className="ent-field__label">Hand off to</span>
            <select name="nextOwnerUserId" className="ent-select">
              <option value="">Keep the next step&rsquo;s default owner</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name || u.email}</option>
              ))}
            </select>
          </label>
        ) : null}
        <button className="ent-btn ent-btn--primary" type="submit">Complete this step</button>
      </form>
    ) : null;

  // Manage — reassign owners + comments, grouped consistently.
  const manage = (
    <div className="ent-manage">
      {!isComplete ? (
        <div className="ent-manage__block">
          <p className="ent-manage__label">Step owners</p>
          <ul className="ent-manage__list">
            {stages.map((s) => (
              <li key={s.id} className="ent-manage__row">
                <span className="ent-manage__name">{s.position}. {s.name}</span>
                <form action={assignStageAction} className="ent-manage__form">
                  <input type="hidden" name="workStageId" value={s.id} />
                  <input type="hidden" name="workInstanceId" value={instance.id} />
                  <select name="userId" defaultValue={s.ownerUserId ?? ''} className="ent-select">
                    <option value="">Unassigned</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>{u.name || u.email}</option>
                    ))}
                  </select>
                  <button className="ent-btn ent-btn--ghost" type="submit">Save</button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="ent-manage__block">
        <p className="ent-manage__label">Comments <span className="ent-count">{instance.comments.length}</span></p>
        {instance.comments.length === 0 ? (
          <p className="ent-empty">No comments yet. Add context here so the next person has what they need.</p>
        ) : (
          <ul className="ent-manage__comments">
            {instance.comments.map((c) => (
              <li key={c.id} className="ent-manage__comment">
                <span className="ent-manage__who">{ownerName(c.userId, users)}</span>
                <span className="ent-manage__text">{c.body}</span>
                <span className="ent-manage__when">{relTime(new Date(c.createdAt))}</span>
              </li>
            ))}
          </ul>
        )}
        <form action={addWorkCommentAction} className="ent-manage__form ent-manage__form--wide">
          <input type="hidden" name="workInstanceId" value={instance.id} />
          <textarea name="body" rows={2} placeholder="Add a comment…" className="ent-textarea" />
          <button className="ent-btn ent-btn--ghost" type="submit">Add comment</button>
        </form>
      </div>
    </div>
  );

  const model: EntityPageModel = {
    eyebrow: 'Work OS',
    title: instance.title,
    subtitle: instance.description ?? (isComplete ? 'A completed work item.' : 'A multi-step work item in your organization.'),
    backHref: '/app/admin/work',
    backLabel: 'Work OS',
    stats,
    health,
    changes,
    whyItMatters,
    primaryAction,
    evidence,
    related,
    history,
    manage,
    manageTitle: 'Manage this work',
    empty: {
      changes: 'No steps have moved yet. Changes appear here as the work advances.',
      actions: isComplete ? 'This work is complete — nothing else needs to happen.' : 'Nothing needs a decision on this work right now.',
      evidence: 'This work has no steps yet.',
    },
  };

  return <EntityPage model={model} />;
}
