// Work detail — the canonical EMG Loop drill-down (EntityPage).
//
// A Work Item is a single entity, so it renders through the permanent
// storytelling pattern: who/what it is, whether it is healthy, what changed,
// why it matters, the completable step (Complete My Step — owner-only), the
// evidence (every step's real state), and the timeline. It reads the Work Item
// created by the configurable workflow engine (createWorkItem): Work Type, the
// captured details + custom fields, priority, Eastern target, the ordered steps
// with their per-step assignment, and every participant.
//
// The active owner completes ONLY their own step; the engine resolves the next
// owner from the defined sequence. There is no manual "reassign the whole item"
// — the only assignment control is putting an owner on the current step when it
// still needs one.
//
// No implementation vocabulary on screen: "stage/status/currentStageId" become
// "step", "Ready/Waiting/Completed", and plain English.

import { notFound } from 'next/navigation';

import { requireWorkActor, workRepo, listAssignableUsers } from '../work-data';
import { assignStageAction, addWorkCommentAction } from '../actions';
import CompleteStepForm from './CompleteStepForm';
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

function meta(obj: unknown): Record<string, unknown> {
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {};
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

  const wmeta = meta(instance.metadata);
  const workTypeId = typeof wmeta.workTypeId === 'string' ? wmeta.workTypeId : null;
  // Load the Work Type only to map custom-field keys → their configured labels.
  const workType = workTypeId ? await work.getWorkType(actor.organizationId, workTypeId) : null;

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
  const iOwnCurrent = current != null && current.ownerUserId === actor.userId;
  const currentCfg = current ? meta(current.metadata) : {};
  const noteMode = currentCfg.completionNote === 'required' || currentCfg.completionNote === 'optional'
    ? (currentCfg.completionNote as 'required' | 'optional')
    : 'none';
  const confirmation = typeof currentCfg.completionConfirmation === 'string' ? currentCfg.completionConfirmation : null;

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
      line: `The step “${current.name}” is ready, but nobody is assigned to it. Put someone on it below.`,
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
      line: iOwnCurrent
        ? `“${current.name}” is yours to complete. Nothing is stuck.`
        : `${currentOwner} is on “${current.name}”. Nothing is stuck.`,
    };
  }

  // Participants — the unique union of the creator and every resolved step owner.
  const participantIds = new Set<string>();
  participantIds.add(instance.createdByUserId);
  for (const s of stages) if (s.ownerUserId) participantIds.add(s.ownerUserId);
  const participantNames = [...participantIds].map((id) => ownerName(id, users));

  // Identity facts (surface each only when it exists — honest, no filler).
  const priority = typeof wmeta.priority === 'string' ? wmeta.priority : null;
  const target = typeof wmeta.targetEastern === 'string' ? wmeta.targetEastern
    : typeof wmeta.dueEastern === 'string' ? wmeta.dueEastern : null;
  const workTypeName = typeof wmeta.workTypeName === 'string' ? wmeta.workTypeName : workType?.name ?? null;
  const details = typeof wmeta.details === 'string' ? wmeta.details : null;
  const customValues = meta(wmeta.customFieldValues);

  const stats: EntityStat[] = [];
  if (workTypeName) stats.push({ label: 'Work Type', value: workTypeName });
  stats.push({ label: 'Progress', value: `${done} / ${total} steps`, tone: isComplete ? 'good' : undefined });
  stats.push({ label: 'Current step', value: current ? current.name : isComplete ? 'None left' : '—' });
  stats.push({ label: 'Owner', value: current ? currentOwner : '—', tone: current && !current.ownerUserId ? 'warn' : undefined });
  if (priority) stats.push({ label: 'Priority', value: priority.charAt(0).toUpperCase() + priority.slice(1) });
  if (target) stats.push({ label: 'Target', value: `${target} ET` });
  stats.push({ label: 'Participants', value: String(participantIds.size) });
  stats.push({ label: 'Started', value: relTime(new Date(instance.createdAt)) || 'Today' });

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

  // 6. Evidence — every step's real state (the ordered workflow timeline).
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

  // The captured details + custom fields (only when present).
  const detailFacts: { statement: string; value: string }[] = [];
  if (details) detailFacts.push({ statement: 'Details', value: details });
  if (workType) {
    for (const f of workType.fields) {
      const v = customValues[f.key];
      if (v !== undefined && v !== null && String(v).length > 0) {
        detailFacts.push({ statement: f.label, value: f.type === 'checkbox' ? (v === true ? 'Yes' : 'No') : String(v) });
      }
    }
  }
  if (detailFacts.length) {
    evidence.push({ label: 'Details', tone: 'info' as EntityTone, facts: detailFacts });
  }

  // Participants block — who is involved in this work.
  evidence.push({
    label: `Participants — ${participantIds.size}`,
    tone: 'info' as EntityTone,
    facts: participantNames.map((n) => ({ statement: 'Person', value: n })),
  });

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

  // 5. The completable step — ONLY the current owner sees Complete My Step. The
  // next owner is resolved from the defined sequence, never chosen here.
  const primaryAction =
    !isComplete && current && iOwnCurrent ? (
      <CompleteStepForm
        workInstanceId={instance.id}
        stageId={current.id}
        stepName={current.name}
        hasNext={hasNext}
        noteMode={noteMode}
        confirmation={confirmation}
      />
    ) : null;

  // Manage — the ONLY assignment control is putting an owner on the current step
  // when it still needs one (or correcting the current owner). No whole-item
  // reassignment: later steps resolve their own owner at handoff.
  const manage = (
    <div className="ent-manage">
      {!isComplete && current ? (
        <div className="ent-manage__block">
          <p className="ent-manage__label">
            {current.ownerUserId ? 'Current step owner' : 'This step needs an owner'}
          </p>
          <div className="ent-manage__row">
            <span className="ent-manage__name">{current.position}. {current.name}</span>
            <form action={assignStageAction} className="ent-manage__form">
              <input type="hidden" name="workStageId" value={current.id} />
              <input type="hidden" name="workInstanceId" value={instance.id} />
              <select name="userId" defaultValue={current.ownerUserId ?? ''} className="ent-select">
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name || u.email}</option>
                ))}
              </select>
              <button className="ent-btn ent-btn--ghost" type="submit">Save</button>
            </form>
          </div>
          {!iOwnCurrent && current.ownerUserId ? (
            <p className="ent-empty">Only {currentOwner} can complete this step. Reassign it here if that’s wrong.</p>
          ) : null}
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

  const actionsEmpty = isComplete
    ? 'This work is complete — nothing else needs to happen.'
    : current && !iOwnCurrent && current.ownerUserId
      ? `Waiting on ${currentOwner} to complete “${current.name}”.`
      : current && !current.ownerUserId
        ? 'This step needs an owner before it can be completed — assign one under “Manage this work”.'
        : 'Nothing needs a decision on this work right now.';

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
      actions: actionsEmpty,
      evidence: 'This work has no steps yet.',
    },
  };

  return <EntityPage model={model} />;
}
