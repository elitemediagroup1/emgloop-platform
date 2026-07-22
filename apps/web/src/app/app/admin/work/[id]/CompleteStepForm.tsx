'use client';

// CompleteStepForm — the smallest client leaf for "Complete My Step". The active
// owner completes their own step; the engine resolves and activates exactly the
// next step by its defined mode (no manual hand-off). Honors the step's
// configured confirmation prompt and completion-note requirement, gating the
// button client-side and re-checking server-side. On success the page
// revalidates and re-renders the advanced work in place.

import { useFormState, useFormStatus } from 'react-dom';
import { completeWorkStepAction, type CompleteStepState } from '../actions';

interface Props {
  workInstanceId: string;
  stageId: string;
  stepName: string;
  hasNext: boolean;
  noteMode: 'none' | 'optional' | 'required';
  confirmation: string | null;
}

function Submit({ blocked }: { blocked: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="ent-btn ent-btn--primary" type="submit" disabled={pending || blocked} aria-busy={pending}>
      {pending ? 'Completing…' : 'Complete my step'}
    </button>
  );
}

export default function CompleteStepForm(props: Props) {
  const [state, formAction] = useFormState<CompleteStepState, FormData>(completeWorkStepAction, {});
  // The button is a plain submit; useFormStatus reads pending. The confirmation
  // checkbox and required note are the two things that can block submission —
  // enforced again server-side, so this is only to guide, never to secure.

  return (
    <form action={formAction} className="ent-manage">
      <input type="hidden" name="workInstanceId" value={props.workInstanceId} />
      <input type="hidden" name="stageId" value={props.stageId} />
      <div className="ent-action__main">
        <span className="ent-action__title">Complete “{props.stepName}”</span>
        <p className="ent-action__why">
          {props.hasNext
            ? 'Marking this step done resolves and notifies the next step’s owner automatically.'
            : 'This is the final step — completing it finishes the work and notifies everyone involved.'}
        </p>
      </div>

      {props.confirmation ? (
        <label className="sw2-check">
          <input type="checkbox" name="confirm" value="on" required /> {props.confirmation}
        </label>
      ) : null}

      {props.noteMode !== 'none' ? (
        <label className="ent-field">
          <span className="ent-field__label">
            Completion note {props.noteMode === 'required' ? '(required)' : <span className="sw2-opt">Optional</span>}
          </span>
          <textarea
            name="note"
            rows={2}
            className="ent-textarea"
            required={props.noteMode === 'required'}
            placeholder="What did you do / hand off?"
          />
        </label>
      ) : null}

      {state.error ? <p className="sw2-err" role="alert">{state.error}</p> : null}
      <Submit blocked={false} />
    </form>
  );
}
