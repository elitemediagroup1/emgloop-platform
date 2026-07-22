'use client';

// StartWorkForm — the client leaf for Start Work. Server component (page.tsx)
// loads real Work Types + active members and passes them in as plain data; this
// component owns only interaction: section state, dynamic requirements, the live
// review summary, field-level errors from the server action, and submit-once.
// No business logic and no data access live here.

import { useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import Link from 'next/link';
import { createWorkAction, type StartWorkState } from '../actions';

export interface WorkTypeOption {
  id: string;
  name: string;
  category: string;
  responsibility: string | null;
  defaultPriority: string;
  hasDefaultAssignee: boolean;
}
export interface MemberOption { id: string; name: string }
interface Labelled { value: string; label: string }

interface Props {
  workTypes: WorkTypeOption[];
  members: MemberOption[];
  responsibilities: Labelled[];
  priorities: Labelled[];
  relations: Labelled[];
  timezoneLabel: string;
}

interface Requirement { name: string; description: string; required: boolean }

const initialState: StartWorkState = {};

function SubmitBar({ disabled }: { disabled: boolean }) {
  // useFormStatus gives the pending state of the enclosing form — the button
  // disables itself while the action runs, which is what prevents a double submit.
  const { pending } = useFormStatus();
  return (
    <div className="sw2-actions">
      <Link href="/app/admin/work" className="adm-btn sw2-cancel">Cancel</Link>
      <button type="submit" className="adm-btn adm-btn--primary sw2-start" disabled={pending || disabled} aria-busy={pending}>
        {pending ? 'Starting…' : 'Start Work'}
      </button>
    </div>
  );
}

export default function StartWorkForm(props: Props) {
  const [state, formAction] = useFormState(createWorkAction, initialState);
  const err = state.errors ?? {};

  // Group work types by category for an organised picker.
  const grouped = useMemo(() => {
    const map = new Map<string, WorkTypeOption[]>();
    for (const wt of props.workTypes) {
      const list = map.get(wt.category) ?? [];
      list.push(wt);
      map.set(wt.category, list);
    }
    return [...map.entries()];
  }, [props.workTypes]);

  const [workTypeId, setWorkTypeId] = useState('');
  const selected = props.workTypes.find((w) => w.id === workTypeId) ?? null;

  const [title, setTitle] = useState('');
  const [responsibility, setResponsibility] = useState('');
  const [assignMode, setAssignMode] = useState<'auto' | 'specific' | 'unassigned'>('unassigned');
  const [assigneeUserId, setAssigneeUserId] = useState('');
  const [priority, setPriority] = useState('normal');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [relationType, setRelationType] = useState('none');
  const [relationLabel, setRelationLabel] = useState('');
  const [requirements, setRequirements] = useState<Requirement[]>([]);

  // When a work type is chosen, prefill its sensible defaults (the user can still
  // change them). These are real config values from the work type.
  function onPickWorkType(id: string) {
    setWorkTypeId(id);
    const wt = props.workTypes.find((w) => w.id === id);
    if (wt) {
      if (wt.responsibility) setResponsibility(wt.responsibility);
      if (wt.defaultPriority) setPriority(wt.defaultPriority);
      setAssignMode(wt.hasDefaultAssignee ? 'auto' : 'unassigned');
    }
  }

  const addRequirement = () => setRequirements((r) => [...r, { name: '', description: '', required: false }]);
  const removeRequirement = (i: number) => setRequirements((r) => r.filter((_, idx) => idx !== i));
  const patchRequirement = (i: number, patch: Partial<Requirement>) =>
    setRequirements((r) => r.map((req, idx) => (idx === i ? { ...req, ...patch } : req)));

  const responsibilityLabel = props.responsibilities.find((r) => r.value === responsibility)?.label ?? '—';
  const assigneeName = props.members.find((m) => m.id === assigneeUserId)?.name ?? null;
  const priorityLabel = props.priorities.find((p) => p.value === priority)?.label ?? priority;
  const relationLabelText = props.relations.find((r) => r.value === relationType)?.label ?? '';
  const namedRequirements = requirements.filter((r) => r.name.trim().length > 0);

  const assignSummary =
    assignMode === 'unassigned' ? 'Unassigned'
      : assignMode === 'auto' ? (selected?.hasDefaultAssignee ? 'Work type default' : 'Unassigned (no default set)')
        : assigneeName ?? 'Not chosen yet';

  return (
    <form action={formAction} className="sw2-form">
      {/* Hidden serialised state the server action reads alongside named fields */}
      <input type="hidden" name="workTypeId" value={workTypeId} />
      <input type="hidden" name="requirements" value={JSON.stringify(namedRequirements)} />

      {state.formError ? <div className="adm-banner adm-banner--error" role="alert">{state.formError}</div> : null}

      {/* 1 — Work Type */}
      <section className="sw2-section">
        <h2 className="sw2-h">What kind of work is this?</h2>
        <p className="sw2-help">Pick the closest work type. It sets sensible defaults you can adjust.</p>
        <select
          className={'sw2-input' + (err.workTypeId ? ' sw2-input--err' : '')}
          value={workTypeId}
          onChange={(e) => onPickWorkType(e.target.value)}
          aria-invalid={!!err.workTypeId}
        >
          <option value="">Choose a work type…</option>
          {grouped.map(([cat, list]) => (
            <optgroup key={cat} label={cat}>
              {list.map((wt) => <option key={wt.id} value={wt.id}>{wt.name}</option>)}
            </optgroup>
          ))}
        </select>
        {err.workTypeId ? <p className="sw2-err">{err.workTypeId}</p> : null}
      </section>

      {/* 2 — Work Details */}
      <section className="sw2-section">
        <h2 className="sw2-h">Work details</h2>
        <label className="sw2-field">
          <span className="sw2-label">Work name</span>
          <input
            name="title" className={'sw2-input' + (err.title ? ' sw2-input--err' : '')}
            value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Set up ABC Roofing as a new buyer" aria-invalid={!!err.title}
          />
          {err.title ? <p className="sw2-err">{err.title}</p> : null}
        </label>
        <label className="sw2-field">
          <span className="sw2-label">What needs to be accomplished?</span>
          <textarea
            name="outcome" rows={5} className={'sw2-input sw2-textarea' + (err.outcome ? ' sw2-input--err' : '')}
            placeholder="Describe the expected outcome, important context, and what “done” should look like."
            aria-invalid={!!err.outcome}
          />
          {err.outcome ? <p className="sw2-err">{err.outcome}</p> : null}
        </label>
        <label className="sw2-field">
          <span className="sw2-label">Additional notes <span className="sw2-opt">Optional</span></span>
          <textarea name="notes" rows={2} className="sw2-input sw2-textarea" placeholder="Anything else worth knowing" />
        </label>
      </section>

      {/* 3 — Related To */}
      <section className="sw2-section">
        <h2 className="sw2-h">What is this work related to? <span className="sw2-opt">Optional</span></h2>
        <div className="sw2-row">
          <label className="sw2-field">
            <span className="sw2-label">Type</span>
            <select name="relationType" className="sw2-input" value={relationType} onChange={(e) => setRelationType(e.target.value)}>
              {props.relations.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          {relationType !== 'none' ? (
            <label className="sw2-field">
              <span className="sw2-label">Reference <span className="sw2-opt">name or ID</span></span>
              <input name="relationLabel" className="sw2-input" value={relationLabel} onChange={(e) => setRelationLabel(e.target.value)} placeholder="e.g. ABC Roofing" />
            </label>
          ) : null}
        </div>
      </section>

      {/* 4 — Responsibility and Assignment */}
      <section className="sw2-section">
        <h2 className="sw2-h">Who is responsible?</h2>
        <div className="sw2-row">
          <label className="sw2-field">
            <span className="sw2-label">Responsibility</span>
            <select name="responsibility" className="sw2-input" value={responsibility} onChange={(e) => setResponsibility(e.target.value)}>
              <option value="">General</option>
              {props.responsibilities.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
        </div>
        <fieldset className="sw2-fieldset">
          <span className="sw2-label">Assign to</span>
          <div className="sw2-radios">
            <label className="sw2-radio">
              <input type="radio" name="assignMode" value="auto" checked={assignMode === 'auto'} onChange={() => setAssignMode('auto')} />
              <span>Use the work type default{selected && !selected.hasDefaultAssignee ? ' (none set — starts unassigned)' : ''}</span>
            </label>
            <label className="sw2-radio">
              <input type="radio" name="assignMode" value="specific" checked={assignMode === 'specific'} onChange={() => setAssignMode('specific')} />
              <span>A specific team member</span>
            </label>
            <label className="sw2-radio">
              <input type="radio" name="assignMode" value="unassigned" checked={assignMode === 'unassigned'} onChange={() => setAssignMode('unassigned')} />
              <span>Leave unassigned</span>
            </label>
          </div>
          {assignMode === 'specific' ? (
            <label className="sw2-field">
              <span className="sw2-label">Team member</span>
              <select
                name="assigneeUserId" className={'sw2-input' + (err.assignee ? ' sw2-input--err' : '')}
                value={assigneeUserId} onChange={(e) => setAssigneeUserId(e.target.value)} aria-invalid={!!err.assignee}
              >
                <option value="">Choose a team member…</option>
                {props.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              {err.assignee ? <p className="sw2-err">{err.assignee}</p> : null}
              {props.members.length === 0 ? <p className="sw2-help">No active team members yet — invite someone on the Team page, or leave this unassigned.</p> : null}
            </label>
          ) : null}
        </fieldset>
      </section>

      {/* 5 — Timing and Priority */}
      <section className="sw2-section">
        <h2 className="sw2-h">Timing and priority</h2>
        <div className="sw2-row">
          <label className="sw2-field">
            <span className="sw2-label">Priority</span>
            <select name="priority" className="sw2-input" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {props.priorities.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          <label className="sw2-field">
            <span className="sw2-label">Due date <span className="sw2-opt">Optional</span></span>
            <input type="date" name="dueDate" className="sw2-input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
          <label className="sw2-field">
            <span className="sw2-label">Due time <span className="sw2-opt">Optional</span></span>
            <input type="time" name="dueTime" className={'sw2-input' + (err.dueTime ? ' sw2-input--err' : '')} value={dueTime} onChange={(e) => setDueTime(e.target.value)} aria-invalid={!!err.dueTime} />
          </label>
        </div>
        <p className="sw2-help">Times are {props.timezoneLabel}.</p>
        {err.dueTime ? <p className="sw2-err">{err.dueTime}</p> : null}
      </section>

      {/* 6 — Requirements */}
      <section className="sw2-section">
        <div className="sw2-sectionhead">
          <h2 className="sw2-h">Requirements <span className="sw2-opt">Optional</span></h2>
          <button type="button" className="adm-btn" onClick={addRequirement}>Add requirement</button>
        </div>
        {requirements.length === 0 ? (
          <p className="sw2-help">Add checklist items that must be satisfied — e.g. “Signed IO received”, “Creative approved”.</p>
        ) : (
          <div className="sw2-reqs">
            {requirements.map((req, i) => (
              <div className="sw2-req" key={i}>
                <input className="sw2-input" placeholder="Requirement" value={req.name} onChange={(e) => patchRequirement(i, { name: e.target.value })} />
                <input className="sw2-input" placeholder="Notes (optional)" value={req.description} onChange={(e) => patchRequirement(i, { description: e.target.value })} />
                <label className="sw2-reqreq"><input type="checkbox" checked={req.required} onChange={(e) => patchRequirement(i, { required: e.target.checked })} /> Required</label>
                <button type="button" className="adm-btn adm-btn--danger" onClick={() => removeRequirement(i)} aria-label="Remove requirement">Remove</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 7 — Review and Start */}
      <section className="sw2-section sw2-review">
        <h2 className="sw2-h">Review and start</h2>
        <dl className="sw2-summary">
          <div><dt>Work Type</dt><dd>{selected?.name ?? '—'}</dd></div>
          <div><dt>Work Name</dt><dd>{title.trim() || '—'}</dd></div>
          <div><dt>Responsibility</dt><dd>{responsibilityLabel}</dd></div>
          <div><dt>Assigned</dt><dd>{assignSummary}</dd></div>
          <div><dt>Priority</dt><dd>{priorityLabel}</dd></div>
          <div><dt>Due</dt><dd>{dueDate ? `${dueDate}${dueTime ? ' ' + dueTime : ''} (${props.timezoneLabel})` : 'No date'}</dd></div>
          <div><dt>Requirements</dt><dd>{namedRequirements.length}</dd></div>
          <div><dt>Related</dt><dd>{relationType === 'none' ? 'Not linked' : `${relationLabelText}${relationLabel ? ': ' + relationLabel : ''}`}</dd></div>
        </dl>
        <SubmitBar disabled={props.workTypes.length === 0} />
      </section>
    </form>
  );
}
