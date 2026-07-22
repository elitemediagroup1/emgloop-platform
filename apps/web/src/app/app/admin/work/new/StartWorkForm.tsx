'use client';

// StartWorkForm — the client leaf for the configurable sequential workflow
// builder. The server component (page.tsx) loads real Work Types (with their
// configured custom fields), active de-duplicated members, and the org's active
// Workflow Templates, and passes them in as plain data. This component owns only
// interaction: section state, the Add-New-Type modal, custom-field inputs, the
// three workflow modes (use a saved template / build / single-person), the
// review, and submit-once. The step editing itself is the shared StepListEditor,
// and validation + owner resolution happen server-side.

import { useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import Link from 'next/link';
import {
  startWorkItemAction,
  addWorkTypeAction,
  type StartWorkState,
  type AddWorkTypeState,
} from '../actions';
import StepListEditor from '../_components/StepListEditor';
import { emptyStep, fromTemplateStep, serialiseStep, type Step, type TemplateStepShape } from '../_components/work-steps';

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
export interface TemplateOption {
  id: string;
  name: string;
  description: string | null;
  workTypeIds: string[];
  stepCount: number;
  updatedAt: string;
  steps: TemplateStepShape[];
}

interface Props {
  workTypes: WorkTypeOption[];
  members: MemberOption[];
  responsibilities: Labelled[];
  priorities: Labelled[];
  templates: TemplateOption[];
  timezoneLabel: string;
}

type WorkflowMode = 'saved' | 'build' | 'single';

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
    setFieldValues({});
    setTemplateId('');
    setWorkflowMode('build');
  }

  function onCreatedType(t: { id: string; name: string }) {
    const nt: WorkTypeOption = { id: t.id, name: t.name, category: 'General', fields: [] };
    setExtraTypes((x) => [...x, nt]);
    setShowAddType(false);
    onPickWorkType(t.id);
  }

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

  // Assignment display for the review (client-side, never authoritative).
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
  const editable = workflowMode !== 'saved';
  const showAdd = workflowMode === 'build';

  return (
    <>
      <form action={formAction} className="sw2-form">
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

              {activeFields.length > 0 ? (
                <div className="sw2-fields">
                  {activeFields.map((f) => (
                    <CustomField
                      key={f.key} def={f} value={fieldValues[f.key]} error={err.fields?.[f.key]}
                      onChange={(v) => setFieldValues((fv) => ({ ...fv, [f.key]: v }))}
                    />
                  ))}
                </div>
              ) : null}

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

              {workflowMode !== 'saved' || templateId ? (
                <StepListEditor
                  steps={steps} onChange={setSteps} members={props.members}
                  responsibilities={props.responsibilities} editable={editable} showAdd={showAdd}
                  errors={err.steps}
                />
              ) : null}

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
