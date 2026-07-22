'use client';

// TemplateEditor — create or edit a reusable Workflow Template. Reuses the shared
// StepListEditor (the same sequential step builder Start Work uses), plus the
// template's name, description, Work Type associations, and steps. Validation +
// persistence happen server-side (saveTemplateAction); this owns only interaction.

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import Link from 'next/link';
import { saveTemplateAction, type SaveTemplateState } from './actions';
import StepListEditor, { type MemberOption, type Labelled } from '../../work/_components/StepListEditor';
import { emptyStep, serialiseStep, type Step } from '../../work/_components/work-steps';

interface Props {
  mode: 'create' | 'edit';
  id?: string;
  initialName?: string;
  initialDescription?: string;
  initialWorkTypeIds?: string[];
  initialSteps?: Step[];
  workTypes: { id: string; name: string }[];
  members: MemberOption[];
  responsibilities: Labelled[];
}

function SaveBar() {
  const { pending } = useFormStatus();
  return (
    <div className="sw2-actions">
      <Link href="/app/admin/administration/workflow-templates" className="adm-btn sw2-cancel">Cancel</Link>
      <button type="submit" className="adm-btn adm-btn--primary" disabled={pending} aria-busy={pending}>
        {pending ? 'Saving…' : 'Save workflow'}
      </button>
    </div>
  );
}

export default function TemplateEditor(props: Props) {
  const [state, formAction] = useFormState<SaveTemplateState, FormData>(saveTemplateAction, {});
  const err = state.errors ?? {};

  const [name, setName] = useState(props.initialName ?? '');
  const [description, setDescription] = useState(props.initialDescription ?? '');
  const [workTypeIds, setWorkTypeIds] = useState<string[]>(props.initialWorkTypeIds ?? []);
  const [steps, setSteps] = useState<Step[]>(props.initialSteps?.length ? props.initialSteps : [emptyStep('Complete the work')]);

  const toggleType = (id: string) =>
    setWorkTypeIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  return (
    <form action={formAction} className="sw2-form">
      <input type="hidden" name="id" value={props.id ?? ''} />
      <input type="hidden" name="steps" value={JSON.stringify(steps.map(serialiseStep))} />
      <input type="hidden" name="workTypeIds" value={JSON.stringify(workTypeIds)} />

      {state.formError ? <div className="adm-banner adm-banner--error" role="alert">{state.formError}</div> : null}

      <section className="sw2-section">
        <h2 className="sw2-h">{props.mode === 'create' ? 'New workflow' : 'Edit workflow'}</h2>
        <label className="sw2-field">
          <span className="sw2-label">Workflow name</span>
          <input className={'sw2-input' + (err.name ? ' sw2-input--err' : '')} value={name} onChange={(e) => setName(e.target.value)} name="name" placeholder="e.g. New Buyer Onboarding" />
          {err.name ? <p className="sw2-err">{err.name}</p> : null}
        </label>
        <label className="sw2-field">
          <span className="sw2-label">Description <span className="sw2-opt">Optional</span></span>
          <input className="sw2-input" value={description} onChange={(e) => setDescription(e.target.value)} name="description" placeholder="When to use this workflow" />
        </label>

        <div className="sw2-field">
          <span className="sw2-label">Available for these work types</span>
          {props.workTypes.length === 0 ? (
            <p className="sw2-help">No work types exist yet — create one first so this workflow has somewhere to appear.</p>
          ) : (
            <div className="wt-checks">
              {props.workTypes.map((t) => (
                <label key={t.id} className="sw2-check">
                  <input type="checkbox" checked={workTypeIds.includes(t.id)} onChange={() => toggleType(t.id)} /> {t.name}
                </label>
              ))}
            </div>
          )}
          {err.workTypes ? <p className="sw2-err">{err.workTypes}</p> : null}
        </div>
      </section>

      <section className="sw2-section">
        <h2 className="sw2-h">Steps</h2>
        <p className="sw2-help">Each step is owned by one person or responsibility and becomes active in order.</p>
        <StepListEditor
          steps={steps} onChange={setSteps} members={props.members}
          responsibilities={props.responsibilities} editable showAdd errors={err.steps}
        />
      </section>

      <section className="sw2-section">
        <SaveBar />
      </section>
    </form>
  );
}
