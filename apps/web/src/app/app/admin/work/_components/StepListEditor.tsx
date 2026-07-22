'use client';

// StepListEditor — the shared sequential step editor used by both Start Work and
// the Workflow Template admin. Controlled: it takes the step list + an onChange
// and renders per-step name / instruction / assignment (all five modes) /
// completion-note requirement / confirmation / notify toggles, plus reorder,
// remove and add. There is always at least one step. No data access here — the
// member + responsibility option lists are passed in.

import { ASSIGN_LABELS, emptyStep, type AssignMode, type NoteMode, type Step } from './work-steps';

export interface MemberOption { id: string; name: string }
export interface Labelled { value: string; label: string }

// Per-step errors keyed by index (from the server's validateWorkflowSteps).
export type StepErrors = { index: number; errors: Partial<Record<'name' | 'instruction' | 'assignee', string>> }[];

function AssignmentPicker({
  step,
  members,
  responsibilities,
  allowPrevious,
  onChange,
}: {
  step: Step;
  members: MemberOption[];
  responsibilities: Labelled[];
  allowPrevious: boolean;
  onChange: (patch: Partial<Step>) => void;
}) {
  const modes: AssignMode[] = ['specific', 'responsibility', 'creator', 'previous', 'unassigned'];
  return (
    <div className="sw2-assign">
      <label className="sw2-field">
        <span className="sw2-label">Assign by</span>
        <select className="sw2-input" value={step.mode} onChange={(e) => onChange({ mode: e.target.value as AssignMode })}>
          {modes.map((m) => (
            <option key={m} value={m} disabled={m === 'previous' && !allowPrevious}>
              {ASSIGN_LABELS[m]}{m === 'previous' && !allowPrevious ? ' (not for the first step)' : ''}
            </option>
          ))}
        </select>
      </label>
      {step.mode === 'specific' ? (
        <label className="sw2-field">
          <span className="sw2-label">Team member</span>
          <select className="sw2-input" value={step.specificUserId} onChange={(e) => onChange({ specificUserId: e.target.value })}>
            <option value="">Choose a team member…</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          {members.length === 0 ? <p className="sw2-help">No active team members yet — invite someone on the Team page.</p> : null}
        </label>
      ) : null}
      {step.mode === 'responsibility' ? (
        <label className="sw2-field">
          <span className="sw2-label">Responsibility</span>
          <select className="sw2-input" value={step.responsibilityKey} onChange={(e) => onChange({ responsibilityKey: e.target.value })}>
            <option value="">Choose a responsibility…</option>
            {responsibilities.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <p className="sw2-help">Until a responsibility is routed to a person, this step waits in “Needs an owner”.</p>
        </label>
      ) : null}
    </div>
  );
}

interface Props {
  steps: Step[];
  onChange: (steps: Step[]) => void;
  members: MemberOption[];
  responsibilities: Labelled[];
  /** When false, structure + content are read-only and only assignment is editable
   *  (Start Work "use a saved workflow" — adjust owners without editing the template). */
  editable?: boolean;
  /** Show the "Add step" button (build a workflow / template admin). */
  showAdd?: boolean;
  errors?: StepErrors;
}

export default function StepListEditor({
  steps,
  onChange,
  members,
  responsibilities,
  editable = true,
  showAdd = true,
  errors,
}: Props) {
  const patch = (i: number, p: Partial<Step>) => onChange(steps.map((s, idx) => (idx === i ? { ...s, ...p } : s)));
  const add = () => onChange([...steps, emptyStep()]);
  const remove = (i: number) => onChange(steps.length <= 1 ? steps : steps.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const errAt = (i: number) => errors?.find((e) => e.index === i)?.errors;

  return (
    <div className="sw2-steps">
      {steps.map((s, i) => {
        const se = errAt(i);
        return (
          <div className="sw2-step" key={i}>
            <div className="sw2-step-head">
              <span className="sw2-step-num">{i + 1}</span>
              {editable ? (
                <input
                  className={'sw2-input sw2-step-name' + (se?.name ? ' sw2-input--err' : '')}
                  value={s.name} onChange={(e) => patch(i, { name: e.target.value })} placeholder="Step name"
                />
              ) : (
                <span className="sw2-step-name-static">{s.name || `Step ${i + 1}`}</span>
              )}
              {editable ? (
                <div className="sw2-step-tools">
                  <button type="button" className="adm-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                  <button type="button" className="adm-btn" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label="Move down">↓</button>
                  <button type="button" className="adm-btn adm-btn--danger" onClick={() => remove(i)} disabled={steps.length <= 1} aria-label="Remove step">Remove</button>
                </div>
              ) : null}
            </div>
            {se?.name ? <p className="sw2-err">{se.name}</p> : null}

            {editable ? (
              <label className="sw2-field">
                <span className="sw2-label">What needs to happen?</span>
                <textarea
                  className={'sw2-input sw2-textarea' + (se?.instruction ? ' sw2-input--err' : '')}
                  rows={2} value={s.instruction} onChange={(e) => patch(i, { instruction: e.target.value })}
                  placeholder="Describe what this step involves"
                />
                {se?.instruction ? <p className="sw2-err">{se.instruction}</p> : null}
              </label>
            ) : s.instruction ? (
              <p className="sw2-step-instruction">{s.instruction}</p>
            ) : null}

            <AssignmentPicker
              step={s} members={members} responsibilities={responsibilities}
              allowPrevious={i > 0} onChange={(p) => patch(i, p)}
            />
            {se?.assignee ? <p className="sw2-err">{se.assignee}</p> : null}

            {editable ? (
              <div className="sw2-step-opts">
                <label className="sw2-field">
                  <span className="sw2-label">Completion note <span className="sw2-opt">from the owner</span></span>
                  <select className="sw2-input" value={s.completionNote} onChange={(e) => patch(i, { completionNote: e.target.value as NoteMode })}>
                    <option value="none">Not required</option>
                    <option value="optional">Optional</option>
                    <option value="required">Required</option>
                  </select>
                </label>
                <label className="sw2-field">
                  <span className="sw2-label">Confirmation shown before completing <span className="sw2-opt">Optional</span></span>
                  <input className="sw2-input" value={s.completionConfirmation} onChange={(e) => patch(i, { completionConfirmation: e.target.value })} placeholder="e.g. Agreement signed and filed?" />
                </label>
                <div className="sw2-step-toggles">
                  <label className="sw2-check"><input type="checkbox" checked={s.notifyActive} onChange={(e) => patch(i, { notifyActive: e.target.checked })} /> Notify when active</label>
                  <label className="sw2-check"><input type="checkbox" checked={s.notifyComplete} onChange={(e) => patch(i, { notifyComplete: e.target.checked })} /> Notify when completed</label>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      {showAdd ? <button type="button" className="adm-btn sw2-addstep" onClick={add}>Add step</button> : null}
    </div>
  );
}
