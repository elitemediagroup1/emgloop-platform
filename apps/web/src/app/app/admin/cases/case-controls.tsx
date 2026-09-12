// The controls a person acts through, and the copy that says what each one does.
//
// EVERY CONTROL IS A <form> POSTING TO A GUARDED SERVER ACTION. No client
// JavaScript, matching every other administration surface in this repository.
// That also means each control is reachable by anyone who can POST to it, which
// is exactly why the action guards itself rather than trusting this file.
//
// THE COPY IS THE PRODUCT. "Pursue this option" rather than "Select"; "Close
// without acting" rather than "Dismiss"; "Correct the plan" rather than "Edit".
// A person pressing one of these is making a governed decision that goes on an
// append-only log with their name on it, and the label should say which decision.
//
// CONSEQUENTIAL ACTS ASK FOR A REASON AND CANNOT BE PRESSED BY ACCIDENT. Closing
// and reopening an investigation sit behind a disclosure and require a written
// reason, because the reason is what makes the record worth anything a year
// later. Nothing here uses a confirm() dialog: a required field a person has to
// fill in is a better speed bump than a modal they learn to dismiss.

import type { ReactNode } from 'react';

import {
  CASE_CONTRIBUTIONS,
  CASE_CONTRIBUTION_DESCRIPTIONS,
  CASE_CONTRIBUTION_LABELS,
  FALSE_POSITIVE_OUTCOMES,
  OPERATIONAL_OUTCOMES,
  RECOMMENDATION_VERBS,
  type CaseContribution,
  type FindingJudgment,
  type OperationalOutcome,
  type RecommendedAction,
} from '@emgloop/shared';

import {
  addParticipantAction,
  closeCaseAction,
  dismissRecommendationAction,
  judgeFindingAction,
  reportEvidenceAction,
  releaseParticipantAction,
  reopenCaseAction,
  reviseMonitoringAction,
  reviseSequenceAction,
  selectRecommendationAction,
} from './actions';

function CaseField({ caseId }: { caseId: string }) {
  // AN IDENTIFIER, NOT AN AUTHORITY. It names the row; the action resolves it
  // within the session's organization and grants nothing on the strength of it.
  return <input type="hidden" name="caseId" value={caseId} />;
}

/** What each outcome means, so a person closing a Case knows what they are recording. */
const OUTCOME_HELP: Record<OperationalOutcome, string> = {
  RECOVERED: 'It came back to where it was.',
  PARTIALLY_RECOVERED: 'It improved, and not all the way.',
  NOT_RECOVERED: 'It did not come back.',
  NO_ACTION_NEEDED: 'Real, and nothing needed doing.',
  FALSE_POSITIVE: 'Loop should not have raised this.',
  ACCEPTED_RISK: 'Real, and we are living with it.',
  NOT_ACTIONABLE: 'Real, and there is nothing we can do.',
  DUPLICATE: 'The same thing as another investigation. It was right, just already known.',
  MERGED: 'Folded into another investigation that now carries it.',
  SUPPRESSED: 'Real, and deliberately silenced for a period.',
  EXPIRED: 'Closed by time rather than by anyone deciding.',
  CONVERTED_TO_WORK: 'It became durable work somewhere else.',
  UNKNOWN: 'We cannot say what happened.',
};

// --- Recommendations -----------------------------------------------------------------

/**
 * What a person can do with one option.
 *
 * SELECTING IS A DECISION TO PURSUE, and the button says so rather than saying
 * "Select". Loop's version of every other option is untouched either way.
 */
export function RecommendationControls({
  caseId,
  optionKey,
  actions,
  selected,
  dismissed,
}: {
  caseId: string;
  optionKey: string;
  actions: readonly RecommendedAction[];
  selected: boolean;
  dismissed: boolean;
}) {
  return (
    <div className="cw-ctl">
      {!selected ? (
        <form action={selectRecommendationAction}>
          <CaseField caseId={caseId} />
          <input type="hidden" name="optionKey" value={optionKey} />
          <button type="submit" className="ent-btn ent-btn--primary">
            Pursue this
          </button>
        </form>
      ) : null}

      {!dismissed ? (
        <form action={dismissRecommendationAction}>
          <CaseField caseId={caseId} />
          <input type="hidden" name="optionKey" value={optionKey} />
          <button type="submit" className="ent-btn ent-btn--ghost">
            Set aside
          </button>
        </form>
      ) : null}

      <details className="cw-ctl__revise">
        <summary>Change the steps</summary>
        {/*
          REORDER BY REMOVING AND ADDING, because that is what the mutation
          truthfully supports: `revise` takes a full replacement list. There is
          no drag handle, because the contract expects a list rather than a move
          operation and a drag interaction would be inventing an API.

          UNCHECKING A STEP REMOVES IT. An unchecked box submits nothing, which
          is why the fields are indexed rather than parallel arrays — parallel
          arrays would misalign and remove the wrong step.
        */}
        <form action={reviseSequenceAction} className="cw-revise">
          <CaseField caseId={caseId} />
          <input type="hidden" name="optionKey" value={optionKey} />
          <input type="hidden" name="stepCount" value={actions.length} />

          <p className="cw-revise__help">
            Uncheck a step to drop it. Edit the wording to change it. Loop's original stays
            recorded either way.
          </p>

          <ol className="cw-revise__steps">
            {[...actions]
              .sort((a, b) => a.position - b.position)
              .map((a, i) => (
                <li key={a.position} className="cw-revise__step">
                  <label className="cw-revise__keep">
                    <input type="checkbox" name={`step.${i}.keep`} defaultChecked />
                    <span className="cw-revise__sr">Keep step {i + 1}</span>
                  </label>
                  <select name={`step.${i}.verb`} defaultValue={a.verb} aria-label={`Step ${i + 1} verb`}>
                    {RECOMMENDATION_VERBS.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    name={`step.${i}.rest`}
                    // The statement opens with its verb; the person edits only
                    // the rest, and the action recomposes the two.
                    defaultValue={a.statement.replace(new RegExp('^' + a.verb + '\\s*'), '')}
                    aria-label={`Step ${i + 1} wording`}
                  />
                </li>
              ))}
          </ol>

          <fieldset className="cw-revise__add">
            <legend>Add a step</legend>
            {/*
              THE VERB IS A SELECT OVER THE SHIPPED VOCABULARY. Loop's
              recommendation verbs describe things a person does to find out or
              decide — they never assert an outcome, which is why "Increase" and
              "Shift" are not among them.
            */}
            <select name="addVerb" defaultValue="Review" aria-label="New step verb">
              {RECOMMENDATION_VERBS.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
            <input type="text" name="addRest" placeholder="the rest of the step" aria-label="New step wording" />
          </fieldset>

          <button type="submit" className="ent-btn ent-btn--ghost">
            Record my version
          </button>
        </form>
      </details>
    </div>
  );
}

// --- Finding -------------------------------------------------------------------------

/**
 * A person judges the claim.
 *
 * A JUDGMENT, NOT EVIDENCE, AND NOT AN EDIT. There is no field here for changing
 * what the claim says, deliberately: a claim changes through evidence and
 * supersession, not because somebody disagrees with it. And accepting or
 * rejecting it does not move what the evidence supports in either direction. The
 * copy says both, because a person who wants to argue with a conclusion should
 * know where the argument actually belongs.
 */
export function FindingControls({
  caseId,
  findingId,
  judgment,
}: {
  caseId: string;
  findingId: string;
  /** The judgment already recorded on this claim, or null when nobody has judged it. */
  judgment: FindingJudgment | null;
}) {
  const rejected = judgment === 'REJECTED';
  return (
    <div className="cw-ctl">
      <p className="cw-ctl__note">
        Accepting or rejecting records your judgement of this claim. It does not change what the
        claim says — a claim changes when the evidence does, or when a newer one supersedes it.
        Accepting does not make it established, and rejecting does not weaken it: whether Loop can
        establish it still depends on the evidence.
      </p>
      <div className="cw-ctl__row">
        {!rejected ? (
          <>
            <form action={judgeFindingAction}>
              <CaseField caseId={caseId} />
              <input type="hidden" name="findingId" value={findingId} />
              <input type="hidden" name="verdict" value="ACCEPT" />
              <button type="submit" className="ent-btn ent-btn--ghost">
                I accept this claim
              </button>
            </form>
            <form action={judgeFindingAction}>
              <CaseField caseId={caseId} />
              <input type="hidden" name="findingId" value={findingId} />
              <input type="hidden" name="verdict" value="REJECT" />
              <button type="submit" className="ent-btn ent-btn--ghost">
                I reject this claim
              </button>
            </form>
          </>
        ) : (
          <p className="cw-ctl__done">
            A person rejected this claim. It is still the claim on this investigation, and Loop keeps
            evaluating the evidence behind it.
          </p>
        )}
      </div>
    </div>
  );
}

// --- Evidence ---------------------------------------------------------------------------

/**
 * A person reports what they know.
 *
 * WHAT THE COPY HAS TO CARRY, because the screen is where this is understood or
 * misunderstood: the statement is recorded as attributed evidence, it is kept in
 * the person's own words, and recording it does not make Loop believe it. A
 * control that said "Add evidence" and nothing else would invite somebody to
 * think they had settled the question.
 *
 * WHAT IT DELIBERATELY DOES NOT OFFER. No reporter field -- who is reporting comes
 * from the session, and a form that let somebody pick would be a way to file a
 * report under another name. No confidence percentage and no verification
 * checkbox: neither is a thing a person may assert about their own report, and a
 * box saying "verified" would be exactly the silent upgrade this whole stage
 * exists to prevent.
 */
export function ReportEvidenceControl({ caseId }: { caseId: string }) {
  return (
    <details className="cw-ctl__add">
      <summary>Report what you know</summary>
      <form action={reportEvidenceAction} className="cw-ctl__form">
        <CaseField caseId={caseId} />
        <p className="cw-ctl__note">
          This is recorded as evidence, in your words, attributed to you and timed. Loop will record
          that <strong>you reported it</strong> — not that it is true. Whether the thing you describe
          is established depends on the evidence for it.
        </p>
        <label className="cw-ctl__label" htmlFor="cw-report-statement">
          What do you know?
        </label>
        <textarea
          id="cw-report-statement"
          name="statement"
          rows={4}
          required
          className="cw-ctl__textarea"
          placeholder="The production API token expired at about 09:15 this morning."
        />
        <button type="submit" className="ent-btn ent-btn--ghost">
          Record what I reported
        </button>
      </form>
    </details>
  );
}

// --- Participation --------------------------------------------------------------------

/**
 * Ask somebody to contribute.
 *
 * THE REQUEST IS REQUIRED. A participant with no stated reason is a name on a
 * list, and whoever arrives at the Case next has to guess what was wanted from
 * them.
 */
export function AddParticipantControl({
  caseId,
  members,
}: {
  caseId: string;
  members: readonly { id: string; name: string | null; email: string }[];
}) {
  return (
    <details className="cw-ctl__add">
      <summary>Ask somebody to contribute</summary>
      <form action={addParticipantAction} className="cw-add">
        <CaseField caseId={caseId} />
        <p className="cw-add__help">
          Asking somebody is not assigning them work. Nothing is created anywhere else.
        </p>

        <label className="cw-add__field">
          <span>Who</span>
          <select name="userId" required defaultValue="">
            <option value="" disabled>Choose a person</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name ?? m.email}</option>
            ))}
          </select>
        </label>

        <fieldset className="cw-add__fs">
          <legend>What for</legend>
          {CASE_CONTRIBUTIONS.map((c: CaseContribution) => (
            <label key={c} className="cw-add__radio">
              <input type="radio" name="contribution" value={c} required />
              <span>
                <strong>{CASE_CONTRIBUTION_LABELS[c]}</strong>
                <em>{CASE_CONTRIBUTION_DESCRIPTIONS[c]}</em>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="cw-add__field">
          <span>What you are asking them for</span>
          <input type="text" name="request" required placeholder="In your own words" />
        </label>

        <button type="submit" className="ent-btn ent-btn--ghost">Ask them</button>
      </form>
    </details>
  );
}

export function ReleaseParticipantControl({
  caseId,
  userId,
  contribution,
}: {
  caseId: string;
  userId: string;
  contribution: string;
}) {
  return (
    <form action={releaseParticipantAction}>
      <CaseField caseId={caseId} />
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="contribution" value={contribution} />
      <button type="submit" className="ent-btn ent-btn--ghost cw-btn--quiet">
        Release
      </button>
    </form>
  );
}

// --- Monitoring -----------------------------------------------------------------------

/**
 * Set or correct what Loop is watching.
 *
 * EVERY FIELD IS DECLARED BEFORE THE ANSWER IS KNOWN, and the form says so. A
 * success criterion written after the numbers are in is a rationalisation, and
 * the only thing that makes a verdict mean anything is that somebody committed
 * to it in advance.
 *
 * LOOP PROPOSES NOTHING HERE. There is no suggested threshold and no default
 * baseline, because a suggested criterion is Loop marking its own homework.
 */
export function MonitoringControls({
  caseId,
  existing,
}: {
  caseId: string;
  existing: {
    condition: string;
    metric: string;
    successThreshold: number;
    failureThreshold: number;
    observationStart: string;
    observationEnd: string;
  } | null;
}) {
  return (
    <details className="cw-ctl__add">
      <summary>{existing ? 'Correct the monitoring plan' : 'Start watching this'}</summary>
      <form action={reviseMonitoringAction} className="cw-add">
        <CaseField caseId={caseId} />
        <p className="cw-add__help">
          {existing
            ? 'A correction is recorded as a new plan. Every earlier version is kept in full, so what you originally said would count stays readable.'
            : 'Write down what would count as this having held before the answer is known. That is the only reason a verdict later means anything.'}
        </p>

        <label className="cw-add__field">
          <span>What is being watched</span>
          <input type="text" name="condition" required defaultValue={existing?.condition ?? ''} />
        </label>
        <label className="cw-add__field">
          <span>Metric</span>
          <input type="text" name="metric" required defaultValue={existing?.metric ?? ''} />
        </label>

        <div className="cw-add__pair">
          <label className="cw-add__field">
            <span>Baseline value</span>
            {/* OPTIONAL, AND ABSENCE IS A REAL ANSWER. A monitor with no
                baseline can detect a threshold breach; it cannot report a
                recovery, and Loop says so rather than inventing a start point. */}
            <input type="number" step="any" name="baselineValue" placeholder="leave blank if unknown" />
          </label>
          <label className="cw-add__field">
            <span>Unit</span>
            <input type="text" name="baselineUnit" defaultValue="RATIO" />
          </label>
        </div>

        <fieldset className="cw-add__fs">
          <legend>Counts as held when</legend>
          <div className="cw-add__pair">
            <label className="cw-add__field">
              <span>Comparison</span>
              <select name="successComparison" defaultValue="AT_OR_ABOVE">
                <option value="AT_OR_ABOVE">at or above</option>
                <option value="AT_OR_BELOW">at or below</option>
              </select>
            </label>
            <label className="cw-add__field">
              <span>Threshold</span>
              <input type="number" step="any" name="successThreshold" required defaultValue={existing?.successThreshold ?? ''} />
            </label>
          </div>
          <label className="cw-add__field">
            <span>In words</span>
            <input type="text" name="successStatement" required placeholder="What a reader should understand by it" />
          </label>
        </fieldset>

        <fieldset className="cw-add__fs">
          <legend>Counts as failed when</legend>
          <div className="cw-add__pair">
            <label className="cw-add__field">
              <span>Comparison</span>
              <select name="failureComparison" defaultValue="AT_OR_BELOW">
                <option value="AT_OR_BELOW">at or below</option>
                <option value="AT_OR_ABOVE">at or above</option>
              </select>
            </label>
            <label className="cw-add__field">
              <span>Threshold</span>
              <input type="number" step="any" name="failureThreshold" required defaultValue={existing?.failureThreshold ?? ''} />
            </label>
          </div>
          <label className="cw-add__field">
            <span>In words</span>
            <input type="text" name="failureStatement" required placeholder="What a reader should understand by it" />
          </label>
        </fieldset>

        <div className="cw-add__pair">
          <label className="cw-add__field">
            <span>Watch from</span>
            <input type="date" name="observationStart" required defaultValue={existing?.observationStart.slice(0, 10) ?? ''} />
          </label>
          <label className="cw-add__field">
            <span>Until</span>
            <input type="date" name="observationEnd" required defaultValue={existing?.observationEnd.slice(0, 10) ?? ''} />
          </label>
        </div>

        <fieldset className="cw-add__fs">
          <legend>Before Loop will judge it</legend>
          {/* THE GATE THAT STOPS SILENCE READING AS SUCCESS. A window with too
              little measurement concludes INCONCLUSIVE rather than passing. */}
          <div className="cw-add__pair">
            <label className="cw-add__field">
              <span>Minimum observations</span>
              <input type="number" name="minimumObservations" min="1" defaultValue="1" />
            </label>
            <label className="cw-add__field">
              <span>Minimum coverage (0–1)</span>
              <input type="number" step="any" min="0" max="1" name="minimumCoverage" placeholder="blank = not required" />
            </label>
          </div>
          <label className="cw-add__check">
            <input type="checkbox" name="requiresCompleteWindow" defaultChecked />
            <span>Wait for the window to finish before judging it</span>
          </label>
        </fieldset>

        <button type="submit" className="ent-btn ent-btn--ghost">
          {existing ? 'Record the correction' : 'Start watching'}
        </button>
      </form>
    </details>
  );
}

// --- Lifecycle ------------------------------------------------------------------------

/**
 * Close an investigation, or bring one back.
 *
 * TWO WAYS TO CLOSE, AND THE PERSON PICKS WHICH. "We acted" and "it did not need
 * action" are different facts, and a single Close button would lose the one that
 * matters — the false-positive rate is the most important number Loop can
 * publish about itself, and it is only computable because this distinction is
 * recorded.
 *
 * A REASON IS REQUIRED, and it is the speed bump. No confirm() dialog: a modal
 * is something people learn to dismiss, and a field they have to fill in makes
 * them think about what they are recording.
 */
export function LifecycleControls({
  caseId,
  open,
  reopenCount,
}: {
  caseId: string;
  open: boolean;
  reopenCount: number;
}) {
  if (!open) {
    return (
      <div className="cw-ctl">
        {reopenCount > 0 ? (
          <p className="cw-ctl__note">
            This has been reopened {reopenCount} {reopenCount === 1 ? 'time' : 'times'}. Every close
            and every reopen is on the log below.
          </p>
        ) : null}
        <details className="cw-ctl__add">
          <summary>Reopen this investigation</summary>
          <form action={reopenCaseAction} className="cw-add">
            <CaseField caseId={caseId} />
            <p className="cw-add__help">
              The earlier resolution stays on the log. A resolution that did not hold is the most
              informative thing an investigation can carry.
            </p>
            <label className="cw-add__field">
              <span>Why is this coming back?</span>
              <input type="text" name="reason" required />
            </label>
            <button type="submit" className="ent-btn ent-btn--ghost">Reopen</button>
          </form>
        </details>
      </div>
    );
  }

  return (
    <div className="cw-ctl">
      <details className="cw-ctl__add">
        <summary>Close this investigation</summary>
        <form action={closeCaseAction} className="cw-add">
          <CaseField caseId={caseId} />
          <p className="cw-add__help">
            Recording what actually happened is the point. "Closed" alone says what you did and
            nothing about what was true, and only the second is worth anything a year from now.
          </p>

          <fieldset className="cw-add__fs">
            <legend>Did anybody act on this?</legend>
            <label className="cw-add__radio">
              <input type="radio" name="acted" value="yes" required />
              <span><strong>Yes — we acted</strong><em>Somebody did something about it.</em></span>
            </label>
            <label className="cw-add__radio">
              <input type="radio" name="acted" value="no" required />
              <span><strong>No — it did not need action</strong><em>Closing it without having acted.</em></span>
            </label>
          </fieldset>

          <label className="cw-add__field">
            <span>What happened</span>
            <select name="outcome" required defaultValue="">
              <option value="" disabled>Choose an outcome</option>
              {OPERATIONAL_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {OUTCOME_HELP[o]}
                  {(FALSE_POSITIVE_OUTCOMES as readonly string[]).includes(o)
                    ? ' (counts against Loop)'
                    : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="cw-add__field">
            <span>Why you are closing it</span>
            <input type="text" name="reason" required />
          </label>

          <button type="submit" className="ent-btn ent-btn--ghost">Close it</button>
        </form>
      </details>
    </div>
  );
}

/** A slot the page fills, so a section never builds its own authority. */
export type ControlSlot = ReactNode;
