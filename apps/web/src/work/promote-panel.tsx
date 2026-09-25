// Promote to Work -- the confirmation, on the page the origin lives on (Loop Intelligence Phase C).
// A server component over `loadPromoteView`: it reads nothing and decides nothing.
//
// IT SAYS EXACTLY WHAT BECOMES SHARED, BEFORE ANYTHING DOES. For a private origin (your own chats or
// mail) the title and outcome below -- as you leave them -- become visible to everyone who can see the
// organization's work; nothing else of the conversation travels. You may edit both. The assignee is a
// suggestion (you); giving it to someone else is offered only to people who may assign work. Nothing is
// created until you tick the confirmation and press the button.

import { PROMOTE_OUTCOME_MAX_CHARS, PROMOTE_TITLE_MAX_CHARS, type PromoteRefusal } from '@emgloop/shared';

import { StateBlock } from '../app/app/_loop-os/record';
import { promoteToWorkAction } from './promote-actions';
import { promoteParams } from './promote-origin';
import type { PromoteView } from './promote';

const REFUSAL_WORDS: Readonly<Record<PromoteRefusal, string>> = Object.freeze({
  NOT_FOUND: 'Loop could not find that any more. It may have been resolved or refreshed.',
  NOT_PERMITTED: 'You cannot promote this to work.',
  STALE: 'This is no longer current, so it cannot be promoted as it stood.',
  STALE_CONFIRMATION: 'It changed after you looked at it. Review it again below before promoting.',
  NOT_CONFIRMED: 'Nothing was created: tick the confirmation to promote it.',
  ALREADY_PROMOTED: 'This was already promoted to work.',
  INVALID_INPUT: 'Nothing was created: give the work a title and an outcome.',
  WORK_TYPE_NOT_FOUND: 'Choose a work type that is still active.',
  ASSIGNEE_NOT_PERMITTED: 'You can take this yourself; giving it to someone else needs permission to assign work.',
  ASSIGNEE_NOT_A_MEMBER: 'That person is not an active member here.',
  NOT_MIGRATED: 'Promote to Work is not available in this environment yet.',
});

export function promoteRefusalWords(code: string | undefined | null): string | null {
  return code && Object.prototype.hasOwnProperty.call(REFUSAL_WORDS, code) ? REFUSAL_WORDS[code as PromoteRefusal] : null;
}

const SHARED_WORDS: Readonly<Record<string, string>> = Object.freeze({ title: 'the title', outcome: 'the outcome', assignee: 'who it is assigned to', targetDate: 'the target date' });

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

export function PromotePanel({ view, returnTo }: { view: PromoteView; returnTo: string }) {
  const { preview } = view;
  if (preview.outcome === 'REFUSED') {
    return (
      <div id="promote" data-promote-refused={preview.refusal}>
        <StateBlock kind="attention" compact title="Promote to Work" body={REFUSAL_WORDS[preview.refusal]} />
      </div>
    );
  }
  const p = preview.proposal;
  const privateOrigin = p.originScope === 'PRINCIPAL';
  return (
    <section id="promote" className="loop-promote" aria-label="Promote to Work" data-promote>
      <h2 className="loop-panel__title">Promote to Work</h2>
      <p className="loop-panel__lead">
        {privateOrigin
          ? `From ${p.originLabel.toLowerCase()}. This stays private until you confirm. When you do, the title and outcome below — as you leave them — become visible to everyone who can see the organization’s work. Nothing else from the conversation is shared.`
          : `From ${p.originLabel}. The title and outcome below become the work item; the ${p.originLabel.toLowerCase()} records that it was promoted.`}
      </p>
      <form action={promoteToWorkAction} className="loop-promote__form">
        {Object.entries(promoteParams(p.origin)).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <input type="hidden" name="fingerprint" value={p.fingerprint} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <label className="loop-field">
          <span>Title (shared)</span>
          <input className="loop-input" name="title" defaultValue={p.title} maxLength={PROMOTE_TITLE_MAX_CHARS} required />
        </label>
        <label className="loop-field">
          <span>Desired outcome (shared)</span>
          <textarea className="loop-input" name="outcome" defaultValue={p.outcome} maxLength={PROMOTE_OUTCOME_MAX_CHARS} rows={3} required />
        </label>
        <label className="loop-field">
          <span>Work type</span>
          <select className="loop-input" name="workTypeId" required defaultValue={view.workTypes[0]?.id ?? ''}>
            {view.workTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="loop-field">
          <span>Assignee (a suggestion — you)</span>
          <select className="loop-input" name="assigneeUserId" defaultValue={p.suggestedAssigneeUserId}>
            {view.assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="loop-field">
          <span>Target date (optional)</span>
          <input className="loop-input" type="date" name="targetDate" defaultValue={iso(p.targetAt)} />
        </label>
        <p className="loop-promote__shared" data-promote-shared>
          Becomes shared: {p.sharedFields.map((f) => SHARED_WORDS[f]).join(', ')}.
        </p>
        <label className="loop-promote__confirm">
          <input type="checkbox" name="confirm" value="yes" required /> I have checked this and want it to become work.
        </label>
        {view.workTypes.length === 0 ? (
          <p className="loop-panel__lead">No active work type exists yet, so nothing can be created. An administrator adds work types in Work.</p>
        ) : (
          <div className="loop-btnrow">
            <button type="submit" className="loop-btn loop-btn--primary">
              Create the work
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
