'use client';

// StartWorkForm — the client leaf for the configurable sequential workflow
// builder. The server component (page.tsx) loads real Work Types (with their
// configured custom fields), active de-duplicated members, and the org's active
// Workflow Templates, and passes them in as plain data. This component owns only
// interaction: section state, the Add-New-Type modal, custom-field inputs, the
// three workflow modes (use a saved template / build / single-person), the step
// builder (all five assignment modes, reorder, remove), the vertical review, and
// submit-once. No business logic and no data access live here — validation and
// owner resolution happen server-side (buildWorkItemSubmission + the engine).

import { useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import Link from 'next/link';
import {
  startWorkItemAction,
  addWorkTypeAction,
  type StartWorkState,
  type AddWorkTypeState,
} from '../actions';

// ---- Prop shapes (plain data from the server) -------------------------------

interface FieldDef {
  key: string;
  label: string;
  helper?: string;
  type: string;
  required: boolean;
  options?: string[];
  sortOrder: number;
  active: boolean;
}
export interface WorkTypeOption {
  id: string;
  name: string;
  category: string;
  fields: FieldDef[];
}
export interface MemberOption { id: string; name: string }
interface Labelled { value: string; label: string }
interface TemplateStep {
  name: string;
  instruction: string;
  mode: string;
  specificUserId: string | null;
  responsibilityKey: string | null;
  completionConfirmation: string | null;
  completionNote: string;
  notifyActive: boolean;
  notifyComplete: boolean;
}
export interface TemplateOption {
  id: string;
  name: string;
  description: string | null;
  workTypeIds: string[];
  stepCount: number;
  updatedAt: string;
  steps: TemplateStep[];
}

interface Props {
  workTypes: WorkTypeOption[];
  members: MemberOption[];
  responsibilities: Labelled[];
  priorities: Labelled[];
  templates: TemplateOption[];
  timezoneLabel: string;
}

// ---- Client step model ------------------------------------------------------

type AssignMode = 'specific' | 'responsibility' | 'creator' | 'previous' | 'unassigned';
type NoteMode = 'none' | 'optional' | 'required';
type WorkflowMode = 'saved' | 'build' | 'single';

interface Step {
  name: string;
  instruction: string;
  mode: AssignMode;
  specificUserId: string;
  responsibilityKey: string;
  completionConfirmation: string;
  completionNote: NoteMode;
  notifyActive: boolean;
  notifyComplete: boolean;
}

const ASSIGN_LABELS: Record<AssignMode, string> = {
  specific: 'A specific team member',
  responsibility: 'A responsibility',
  creator: 'Whoever starts this work',
  previous: 'Whoever completed the previous step',
  unassigned: 'Leave unassigned',
};

function emptyStep(name = ''): Step {
  return {
    name,
    instruction: '',
    mode: 'unassigned',
    specificUserId: '',
    responsibilityKey: '',
    completionConfirmation: '',
    completionNote: 'none',
    notifyActive: true,
    notifyComplete: false,
  };
}

function fromTemplateStep(t: TemplateStep): Step {
  const mode = (['specific', 'responsibility', 'creator', 'previous', 'unassigned'] as string[]).includes(t.mode)
    ? (t.mode as AssignMode)
    : 'unassigned';
  const note = t.completionNote === 'optional' || t.completionNote === 'required' ? (t.completionNote as NoteMode) : 'none';
  return {
    name: t.name,
    instruction: t.instruction,
    mode,
    specificUserId: t.specificUserId ?? '',
    responsibilityKey: t.responsibilityKey ?? '',
    completionConfirmation: t.completionConfirmation ?? '',
    completionNote: note,
    notifyActive: t.notifyActive,
    notifyComplete: t.notifyComplete,
  };
}

// Serialise a client step into the shape the server action's coerceStep reads.
function serialiseStep(s: Step) {
  return {
    name: s.name,
    instruction: s.instruction,
    mode: s.mode,
    specificUserId: s.mode === 'specific' ? s.specificUserId : null,
    responsibilityKey: s.mode === 'responsibility' ? s.responsibilityKey : null,
    completionConfirmation: s.completionConfirmation.trim() || null,
    completionNote: s.completionNote,
    notifyActive: s.notifyActive,
    notifyComplete: s.notifyComplete,
  };
}

// ---- Submit bar -------------------------------------------------------------

function SubmitBar({ disabled }: { disabled: boolean }) {
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

// ---- Add New Type modal -----------------------------------------------------

function AddTypeModal({
  onCreated,
  onClose,
}: {
  onCreated: (t: { id: string; name: string }) => void;
  onClose: () => void;
}) {
  const [state, formAction] = useFormState(
    async (prev: AddWorkTypeState, fd: FormData): Promise<AddWorkTypeState> => {
      const res = await addWorkTypeAction(prev, fd);
      if (res.ok && res.id && res.name) onCreated({ id: res.id, name: res.name });
      return res;
    },
    {},
  );
  return (
    <div className="sw2-modal-backdrop" role="dialog" aria-modal="true" aria-label="Add a new work type">
      <div className="sw2-modal">
        <h3 className="sw2-modal-title">Add a new work type</h3>
        <p className="sw2-help">Types are saved for your whole organization and appear here right away.</p>
        <form action={formAction} className="sw2-modal-form">
          <label className="sw2-field">
            <span className="sw2-label">Type name</span>
            <input name="name" className="sw2-input" placeholder="e.g. Partner" autoFocus />
          </label>
          <label className="sw2-field">
            <span className="sw2-label">Description <span className="sw2-opt">Optional</span></span>
            <textarea name="description" rows={2} className="sw2-input sw2-textarea" placeholder="What this kind of work concerns" />
          </label>
          {state.error ? <p className="sw2-err">{state.error}</p> : null}
          <div className="sw2-modal-actions">
            <button type="button" className="adm-btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="adm-btn adm-btn--primary">Save type</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---- Per-step assignment picker (shared by build + saved modes) -------------

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
        <select
          className="sw2-input"
          value={step.mode}
          onChange={(e) => onChange({ mode: e.target.value as AssignMode })}
        >
          {modes.map((m) => (
            <option key={m} value={m} disabled={m === 'previous' && !allowPrevious}>
              {ASSIGN_LABELS[m]}
              {m === 'previous' && !allowPrevious ? ' (not for the first step)' : ''}
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

// ---- Main form --------------------------------------------------------------

export default function StartWorkForm(props: Props) {
  const [state, formAction] = useFormState<StartWorkState, FormData>(startWorkItemAction, {});
  const err = state.errors ?? {};

  // Work Types (base + any created in-session via the modal), grouped by category.
  const [extraTypes, setExtraTypes] = useState<WorkTypeOption[]>([]);
  const allTypes = useMemo(() => [...props.workTypes, ...extraTypes], [props.workTypes, extraTypes]);
  const grouped = useMemo(() => {
    const map = new Map<string, WorkTypeOption[]>();
    for (const wt of allTypes) {
      const list = map.get(wt.category) ?? [];
      list.push(wt);
      map.set(wt.category, list);
    }
    return [...map.entries()];
  }, [allTypes]);

  const [workTypeId, setWorkTypeId] = useState('');
  const selected = allTypes.find((w) => w.id === workTypeId) ?? null;
  const [showAddType, setShowAddType] = useState(false);

  const [title, setTitle] = useState('');
  const [outcome, setOutcome] = useState('');
  const [details, setDetails] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, string | boolean>>({});

  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>('build');
  const [templateId, setTemplateId] = useState('');
  const [steps, setSteps] = useState<Step[]>([emptyStep('Complete the work')]);

  const [saveTemplate, setSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');

  const [priority, setPriority] = useState('normal');
  const [targetDate, setTargetDate] = useState('');
  const [useTime, setUseTime] = useState(false);
  const [targetTime, setTargetTime] = useState('');

  const activeFields = useMemo(
    () => (selected?.fields ?? []).filter((f) => f.active).sort((a, b) => a.sortOrder - b.sortOrder),
    [selected],
  );
  const availableTemplates = useMemo(
    () => props.templates.filter((t) => t.workTypeIds.includes(workTypeId)),
    [props.templates, workTypeId],
  );

  function onPickWorkType(id: string) {
    setWorkTypeId(id);
    setFieldValues({}); // different type → different fields
    setTemplateId('');
    // A freshly picked type with no saved templates defaults to Build.
    setWorkflowMode('build');
  }

  function onCreatedType(t: { id: string; name: string }) {
    const nt: WorkTypeOption = { id: t.id, name: t.name, category: 'General', fields: [] };
    setExtraTypes((x) => [...x, nt]);
    setShowAddType(false);
    onPickWorkType(t.id);
  }

  // --- Step editing ---
  const patchStep = (i: number, patch: Partial<Step>) =>
    setSteps((s) => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));
  const addStep = () => setSteps((s) => [...s, emptyStep()]);
  const removeStep = (i: number) => setSteps((s) => (s.length <= 1 ? s : s.filter((_, idx) => idx !== i)));
  const moveStep = (i: number, dir: -1 | 1) =>
    setSteps((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const next = [...s];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  function onPickWorkflowMode(mode: WorkflowMode) {
    setWorkflowMode(mode);
    if (mode === 'single') setSteps([{ ...emptyStep('Complete the work'), mode: 'creator' }]);
    if (mode === 'build') setSteps((s) => (s.length ? s : [emptyStep('Complete the work')]));
  }

  function onPickTemplate(id: string) {
    setTemplateId(id);
    const t = props.templates.find((x) => x.id === id);
    if (t) setSteps(t.steps.map(fromTemplateStep));
  }

  // --- Assignment display (client-side, for the review — never authoritative) ---
  function assignmentText(s: Step, index: number): string {
    switch (s.mode) {
      case 'specific':
        return props.members.find((m) => m.id === s.specificUserId)?.name ?? 'Not chosen yet';
      case 'responsibility': {
        const label = props.responsibilities.find((r) => r.value === s.responsibilityKey)?.label ?? 'Not chosen yet';
        return `${label} — waits for an owner`;
      }
      case 'creator':
        return 'Whoever starts this work';
      case 'previous':
        return index === 0 ? 'Needs an owner (no previous step)' : 'Whoever completed the previous step';
      case 'unassigned':
      default:
        return 'Needs an owner';
    }
  }

  const firstOwnerText = steps.length ? assignmentText(steps[0]!, 0) : '—';
  const participantCount = useMemo(() => {
    const set = new Set<string>();
    set.add('creator');
    for (const s of steps) if (s.mode === 'specific' && s.specificUserId) set.add(s.specificUserId);
    return set.size;
  }, [steps]);

  const priorityLabel = props.priorities.find((p) => p.value === priority)?.label ?? priority;
  const stepErrorAt = (i: number) => err.steps?.find((e) => e.index === i)?.errors;
  const showBuilder = workflowMode !== 'saved' || steps.length > 0;

  return (
    <>
      <form action={formAction} className="sw2-form">
        {/* Hidden serialised state the server action reads */}
        <input type="hidden" name="workTypeId" value={workTypeId} />
        <input type="hidden" name="steps" value={JSON.stringify(steps.map(serialiseStep))} />
        <input type="hidden" name="fieldValues" value={JSON.stringify(fieldValues)} />
        <input type="hidden" name="useTime" value={useTime ? 'on' : ''} />
        <input type="hidden" name="saveTemplate" value={workflowMode === 'build' && saveTemplate ? 'on' : ''} />

        {state.formError ? <div className="adm-banner adm-banner--error" role="alert">{state.formError}</div> : null}

        {/* 1 — Select Work Type */}
        <section className="sw2-section">
          <h2 className="sw2-h">What are you starting?</h2>
          <p className="sw2-help">Pick what this work concerns. This sets any type-specific details below.</p>
          <div className="sw2-row">
            <select className="sw2-input" value={workTypeId} onChange={(e) => onPickWorkType(e.target.value)}>
              <option value="">Choose a work type…</option>
              {grouped.map(([cat, list]) => (
                <optgroup key={cat} label={cat}>
                  {list.map((wt) => <option key={wt.id} value={wt.id}>{wt.name}</option>)}
                </optgroup>
              ))}
            </select>
            <button type="button" className="adm-btn" onClick={() => setShowAddType(true)}>Add new type</button>
          </div>
        </section>

        {selected ? (
          <>
            {/* 2 — Work Information */}
            <section className="sw2-section">
              <h2 className="sw2-h">Work information</h2>
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
                  name="outcome" rows={4} className={'sw2-input sw2-textarea' + (err.outcome ? ' sw2-input--err' : '')}
                  value={outcome} onChange={(e) => setOutcome(e.target.value)}
                  placeholder="Describe the expected outcome and what “done” looks like." aria-invalid={!!err.outcome}
                />
                {err.outcome ? <p className="sw2-err">{err.outcome}</p> : null}
              </label>
              <label className="sw2-field">
                <span className="sw2-label">Important details <span className="sw2-opt">Optional</span></span>
                <textarea name="details" rows={2} className="sw2-input sw2-textarea" value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Anything else worth knowing" />
              </label>

              {/* Type-specific configured fields */}
              {activeFields.length > 0 ? (
                <div className="sw2-fields">
                  {activeFields.map((f) => (
                    <CustomField
                      key={f.key}
                      def={f}
                      value={fieldValues[f.key]}
                      error={err.fields?.[f.key]}
                      onChange={(v) => setFieldValues((fv) => ({ ...fv, [f.key]: v }))}
                    />
                  ))}
                </div>
              ) : null}

              {/* Related record — honest: no first-class record source exists yet */}
              <div className="sw2-note">
                Linking to a {selected.name} record isn’t available yet — this work will be created without a linked record.
              </div>
            </section>

            {/* 3 — Select or Build Workflow */}
            <section className="sw2-section">
              <h2 className="sw2-h">How should this work move?</h2>
              <div className="sw2-modes">
                <ModeCard label="Use a saved workflow" active={workflowMode === 'saved'} disabled={availableTemplates.length === 0}
                  hint={availableTemplates.length === 0 ? 'No saved workflows for this type yet' : `${availableTemplates.length} available`}
                  onClick={() => onPickWorkflowMode('saved')} />
                <ModeCard label="Build a workflow" active={workflowMode === 'build'} hint="Define the steps and who owns each"
                  onClick={() => onPickWorkflowMode('build')} />
                <ModeCard label="Single-person work" active={workflowMode === 'single'} hint="One step, one owner"
                  onClick={() => onPickWorkflowMode('single')} />
              </div>

              {workflowMode === 'saved' ? (
                <div className="sw2-saved">
                  <label className="sw2-field">
                    <span className="sw2-label">Saved workflow</span>
                    <select className="sw2-input" value={templateId} onChange={(e) => onPickTemplate(e.target.value)}>
                      <option value="">Choose a saved workflow…</option>
                      {availableTemplates.map((t) => (
                        <option key={t.id} value={t.id}>{t.name} — {t.stepCount} step{t.stepCount === 1 ? '' : 's'}</option>
                      ))}
                    </select>
                  </label>
                  {templateId ? <p className="sw2-help">You can adjust who owns each step below — this won’t change the saved workflow.</p> : null}
                </div>
              ) : null}

              {/* Step builder — shown for build/single, and for saved once a template is chosen */}
              {(workflowMode !== 'saved' || templateId) && showBuilder ? (
                <div className="sw2-steps">
                  {steps.map((s, i) => {
                    const se = stepErrorAt(i);
                    const editable = workflowMode === 'build';
                    return (
                      <div className="sw2-step" key={i}>
                        <div className="sw2-step-head">
                          <span className="sw2-step-num">{i + 1}</span>
                          {editable ? (
                            <input className={'sw2-input sw2-step-name' + (se?.name ? ' sw2-input--err' : '')}
                              value={s.name} onChange={(e) => patchStep(i, { name: e.target.value })} placeholder="Step name" />
                          ) : (
                            <span className="sw2-step-name-static">{s.name || `Step ${i + 1}`}</span>
                          )}
                          {editable ? (
                            <div className="sw2-step-tools">
                              <button type="button" className="adm-btn" onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                              <button type="button" className="adm-btn" onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} aria-label="Move down">↓</button>
                              <button type="button" className="adm-btn adm-btn--danger" onClick={() => removeStep(i)} disabled={steps.length <= 1} aria-label="Remove step">Remove</button>
                            </div>
                          ) : null}
                        </div>
                        {se?.name ? <p className="sw2-err">{se.name}</p> : null}

                        {editable ? (
                          <>
                            <label className="sw2-field">
                              <span className="sw2-label">What needs to happen?</span>
                              <textarea className={'sw2-input sw2-textarea' + (se?.instruction ? ' sw2-input--err' : '')}
                                rows={2} value={s.instruction} onChange={(e) => patchStep(i, { instruction: e.target.value })}
                                placeholder="Describe what this step involves" />
                              {se?.instruction ? <p className="sw2-err">{se.instruction}</p> : null}
                            </label>
                          </>
                        ) : (
                          <p className="sw2-step-instruction">{s.instruction}</p>
                        )}

                        <AssignmentPicker
                          step={s} members={props.members} responsibilities={props.responsibilities}
                          allowPrevious={i > 0}
                          onChange={(patch) => patchStep(i, patch)}
                        />
                        {se?.assignee ? <p className="sw2-err">{se.assignee}</p> : null}

                        {editable ? (
                          <div className="sw2-step-opts">
                            <label className="sw2-field">
                              <span className="sw2-label">Completion note <span className="sw2-opt">from the owner</span></span>
                              <select className="sw2-input" value={s.completionNote} onChange={(e) => patchStep(i, { completionNote: e.target.value as NoteMode })}>
                                <option value="none">Not required</option>
                                <option value="optional">Optional</option>
                                <option value="required">Required</option>
                              </select>
                            </label>
                            <label className="sw2-field">
                              <span className="sw2-label">Confirmation shown before completing <span className="sw2-opt">Optional</span></span>
                              <input className="sw2-input" value={s.completionConfirmation} onChange={(e) => patchStep(i, { completionConfirmation: e.target.value })} placeholder="e.g. Agreement signed and filed?" />
                            </label>
                            <div className="sw2-step-toggles">
                              <label className="sw2-check"><input type="checkbox" checked={s.notifyActive} onChange={(e) => patchStep(i, { notifyActive: e.target.checked })} /> Notify when active</label>
                              <label className="sw2-check"><input type="checkbox" checked={s.notifyComplete} onChange={(e) => patchStep(i, { notifyComplete: e.target.checked })} /> Notify when completed</label>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}

                  {workflowMode === 'build' ? (
                    <button type="button" className="adm-btn sw2-addstep" onClick={addStep}>Add step</button>
                  ) : null}
                </div>
              ) : null}

              {/* Save as template (build mode only) */}
              {workflowMode === 'build' ? (
                <div className="sw2-savetpl">
                  <label className="sw2-check">
                    <input type="checkbox" checked={saveTemplate} onChange={(e) => setSaveTemplate(e.target.checked)} /> Save this workflow for future use
                  </label>
                  {saveTemplate ? (
                    <div className="sw2-row">
                      <label className="sw2-field">
                        <span className="sw2-label">Workflow name</span>
                        <input name="templateName" className="sw2-input" value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="e.g. New Buyer Onboarding" />
                      </label>
                      <label className="sw2-field">
                        <span className="sw2-label">Description <span className="sw2-opt">Optional</span></span>
                        <input name="templateDescription" className="sw2-input" value={templateDescription} onChange={(e) => setTemplateDescription(e.target.value)} />
                      </label>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>

            {/* 4 — Review Step Assignments (vertical) */}
            <section className="sw2-section">
              <h2 className="sw2-h">Review step assignments</h2>
              <ol className="sw2-timeline">
                {steps.map((s, i) => (
                  <li className="sw2-tl-step" key={i}>
                    <div className="sw2-tl-num">{i + 1}</div>
                    <div className="sw2-tl-body">
                      <div className="sw2-tl-name">{s.name || `Step ${i + 1}`}</div>
                      <div className="sw2-tl-assign">Assigned to {assignmentText(s, i)}</div>
                      {s.instruction ? <div className="sw2-tl-instruction">{s.instruction}</div> : null}
                      {s.completionNote !== 'none' ? (
                        <div className="sw2-tl-note">Completion note {s.completionNote === 'required' ? 'required' : 'optional'}</div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            {/* 5 — Timing and Priority */}
            <section className="sw2-section">
              <h2 className="sw2-h">Priority and target date</h2>
              <div className="sw2-row">
                <label className="sw2-field">
                  <span className="sw2-label">Priority</span>
                  <select name="priority" className="sw2-input" value={priority} onChange={(e) => setPriority(e.target.value)}>
                    {props.priorities.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </label>
                <label className="sw2-field">
                  <span className="sw2-label">Target completion date <span className="sw2-opt">Optional</span></span>
                  <input type="date" name="targetDate" className="sw2-input" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
                </label>
              </div>
              <label className="sw2-check">
                <input type="checkbox" checked={useTime} onChange={(e) => setUseTime(e.target.checked)} /> Add a specific time
              </label>
              {useTime ? (
                <label className="sw2-field">
                  <span className="sw2-label">Target completion time</span>
                  <input type="time" name="targetTime" className={'sw2-input' + (err.targetTime ? ' sw2-input--err' : '')} value={targetTime} onChange={(e) => setTargetTime(e.target.value)} aria-invalid={!!err.targetTime} />
                  {err.targetTime ? <p className="sw2-err">{err.targetTime}</p> : null}
                </label>
              ) : null}
              <p className="sw2-help">Times are {props.timezoneLabel}.</p>
            </section>

            {/* 6 — Review and Start */}
            <section className="sw2-section sw2-review">
              <h2 className="sw2-h">Review and start</h2>
              <dl className="sw2-summary">
                <div><dt>Work Type</dt><dd>{selected.name}</dd></div>
                <div><dt>Work Name</dt><dd>{title.trim() || '—'}</dd></div>
                <div><dt>Related Record</dt><dd>Not linked</dd></div>
                <div><dt>Workflow</dt><dd>{workflowMode === 'saved' ? (props.templates.find((t) => t.id === templateId)?.name ?? 'Saved workflow') : workflowMode === 'single' ? 'Single-person work' : 'Custom workflow'}</dd></div>
                <div><dt>Steps</dt><dd>{steps.length}</dd></div>
                <div><dt>First Active Owner</dt><dd>{firstOwnerText}</dd></div>
                <div><dt>Participants</dt><dd>{participantCount}</dd></div>
                <div><dt>Priority</dt><dd>{priorityLabel}</dd></div>
                <div><dt>Target Completion</dt><dd>{targetDate ? `${targetDate}${useTime && targetTime ? ' ' + targetTime : ''} (${props.timezoneLabel})` : 'No date'}</dd></div>
              </dl>
              <SubmitBar disabled={!workTypeId} />
            </section>
          </>
        ) : null}
      </form>

      {showAddType ? <AddTypeModal onCreated={onCreatedType} onClose={() => setShowAddType(false)} /> : null}
    </>
  );
}

// ---- Mode card --------------------------------------------------------------

function ModeCard({ label, hint, active, disabled, onClick }: { label: string; hint: string; active: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={'sw2-mode' + (active ? ' sw2-mode--active' : '')} onClick={onClick} disabled={disabled} aria-pressed={active}>
      <span className="sw2-mode-label">{label}</span>
      <span className="sw2-mode-hint">{hint}</span>
    </button>
  );
}

// ---- Custom field input -----------------------------------------------------

function CustomField({
  def,
  value,
  error,
  onChange,
}: {
  def: FieldDef;
  value: string | boolean | undefined;
  error?: string;
  onChange: (v: string | boolean) => void;
}) {
  const label = (
    <span className="sw2-label">
      {def.label}{def.required ? '' : <span className="sw2-opt">Optional</span>}
    </span>
  );
  const cls = 'sw2-input' + (error ? ' sw2-input--err' : '');
  const str = typeof value === 'string' ? value : '';

  if (def.type === 'checkbox') {
    return (
      <label className="sw2-check">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {def.label}
      </label>
    );
  }
  if (def.type === 'long_text') {
    return (
      <label className="sw2-field">
        {label}
        <textarea className={cls + ' sw2-textarea'} rows={2} value={str} onChange={(e) => onChange(e.target.value)} />
        {def.helper ? <p className="sw2-help">{def.helper}</p> : null}
        {error ? <p className="sw2-err">{error}</p> : null}
      </label>
    );
  }
  if (def.type === 'dropdown') {
    return (
      <label className="sw2-field">
        {label}
        <select className={cls} value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {(def.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        {def.helper ? <p className="sw2-help">{def.helper}</p> : null}
        {error ? <p className="sw2-err">{error}</p> : null}
      </label>
    );
  }
  const inputType =
    def.type === 'number' || def.type === 'currency' ? 'number'
      : def.type === 'date' ? 'date'
        : def.type === 'time' ? 'time'
          : def.type === 'email' ? 'email'
            : def.type === 'phone' ? 'tel'
              : def.type === 'url' ? 'url'
                : 'text';
  return (
    <label className="sw2-field">
      {label}
      <input
        type={inputType}
        step={def.type === 'currency' ? '0.01' : undefined}
        className={cls}
        value={str}
        onChange={(e) => onChange(e.target.value)}
      />
      {def.helper ? <p className="sw2-help">{def.helper}</p> : null}
      {error ? <p className="sw2-err">{error}</p> : null}
    </label>
  );
}
