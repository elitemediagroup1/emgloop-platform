// Every Stage 4 product state on one page, for Charlie and Lexi.
//
// WHY THIS EXISTS. The most important states in this product are the ones you
// can only see while something is wrong. Nobody should have to wait for a
// provider outage to find out what "Loop can't tell" looks like, and nobody
// should design the escalation-with-no-recipient case by guessing at its shape.
//
// FAIL-CLOSED, ON THE GATE THAT ALREADY EXISTS. `isDemoSeedEnabled` is the
// repository's existing answer to "may this environment show invented data": it
// requires an explicit opt-in AND a non-production runtime, and returns false
// when either is missing. Reusing it means this page cannot appear in production
// even if somebody links to it, and there is no second environment policy to
// keep in sync.
//
// THE FIXTURES ARE THE REAL CONTRACTS. Every value on this page is typed as the
// shape production returns, so a contract change stops it compiling. A review
// harness that renders better than production teaches a designer to build for a
// Loop that does not exist.
//
// IT IS NOT AN INTELLIGENCE SOURCE. Nothing here reads the database, nothing
// writes, and no production code path imports the fixtures. A test asserts the
// last part.

import { notFound } from 'next/navigation';

import {
  FINDING_DEVELOPING_ACCEPTED,
  FINDING_DEVELOPING_REJECTED,
  FINDING_ESTABLISHED_ACCEPTED,
  FINDING_ESTABLISHED_REJECTED,
  MORNING_ALL_CLEAR,
  MORNING_CANT_TELL,
  MORNING_NEEDS_ATTENTION,
  MORNING_NOTHING_TO_CHECK,
  MONITORING_HELD,
  MONITORING_INCONCLUSIVE,
  OUTCOME_RECOVERED_NO_CAUSE,
  OUTCOME_UNESTABLISHED,
  PATTERN_EMERGING,
  PATTERN_OBSERVATION,
  WORK_BLOCKED,
  WORK_ESCALATION_ELIGIBLE,
  WORK_IN_PROGRESS,
  WORK_NOT_MEASURED,
  WORK_REFERENCE_DANGLING,
  isDemoSeedEnabled,
} from '@emgloop/shared';

import { requirePermission } from '../../../../auth/guard';
import { NotKnown, ReadError, StateBadge } from '../../_loop-os/product-state';
import { AttentionBanner } from '../headlines/headline-ui';
import { FindingSection, OutcomeSection, WorkSection } from '../cases/case-sections';
import {
  FindingControls,
  LifecycleControls,
  MonitoringControls,
  RecommendationControls,
} from '../cases/case-controls';
import { PatternCard } from './pattern-ui';

export const dynamic = 'force-dynamic';

/**
 * The Case id every control on this page names.
 *
 * DELIBERATELY NOT A REAL ONE. Pressing a control here posts to the genuine
 * guarded action, which resolves this id within the signed-in organization,
 * finds nothing, and returns the not-found message. So the controls are the real
 * ones and they cannot touch a real investigation — the harness has no
 * production id to name, which is a stronger guarantee than a disabled button.
 */
const REVIEW_CASE_ID = 'case_review_fixture_not_a_real_investigation';

function State({ name, note, children }: { name: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rv-state">
      <header className="rv-state__head">
        <h2 className="rv-state__name">{name}</h2>
        {note ? <p className="rv-state__note">{note}</p> : null}
      </header>
      <div className="rv-state__body">{children}</div>
    </section>
  );
}

export default async function ReviewPage() {
  // GUARDED LIKE EVERY OTHER SURFACE. A review page is still a page.
  await requirePermission('commercialIntelligence', 'view');

  // AND GATED ON THE ENVIRONMENT, fail-closed. Production returns not-found:
  // indistinguishable from a route that does not exist, so this page does not
  // advertise itself where it must not run.
  if (!isDemoSeedEnabled(process.env)) notFound();

  return (
    <div className="rv-page">
      <header className="rv-head">
        <p className="rv-head__eyebrow">Design review · development only</p>
        <h1 className="rv-head__title">Every Stage 4 state, on one page</h1>
        <p className="rv-head__sub">
          Twenty representative states, typed as the contracts production returns. Nothing here
          reads the database and nothing here is real. The numbers, buyers and people are invented.
        </p>
      </header>

      <State
        name="Morning · all clear"
        note="Three objectives, all measurable, nothing raised. The only genuinely good morning."
      >
        <AttentionBanner attention={MORNING_ALL_CLEAR} />
      </State>

      <State
        name="Morning · can't tell"
        note="Zero Headlines, and three of six objectives could not be measured — for three different reasons, which lead to three different next moves. This must never render as all clear."
      >
        <AttentionBanner attention={MORNING_CANT_TELL} />
      </State>

      <State
        name="Morning · needs attention"
        note="Something is on the list, and two objectives still went unmeasured. Acting on one Headline must not hide that."
      >
        <AttentionBanner attention={MORNING_NEEDS_ATTENTION} />
      </State>

      <State
        name="Morning · nothing to check"
        note="Nobody has told Loop what to watch. Complete coverage of nothing is not health."
      >
        <AttentionBanner attention={MORNING_NOTHING_TO_CHECK} />
      </State>

      <State name="Work · in progress" note="The ordinary case: somebody is on it, inside policy.">
        <WorkSection coordination={WORK_IN_PROGRESS} />
      </State>

      <State
        name="Work · blocked"
        note="The clock is paused and the hours already spent actionable are kept. The blocker is named and its expected resolution is shown, or its absence is."
      >
        <WorkSection coordination={WORK_BLOCKED} />
      </State>

      <State
        name="Work · escalation eligible, no recipient"
        note="The state a design has to be built against. Loop can tell it is eligible; it cannot tell who it should go to, and saying so beats naming somebody who never accepted the accountability."
      >
        <WorkSection coordination={WORK_ESCALATION_ELIGIBLE} />
      </State>

      <State
        name="Work · never measured"
        note="Every work item created before the execution foundation is here. UNKNOWN, not on track."
      >
        <WorkSection coordination={WORK_NOT_MEASURED} />
      </State>

      <State
        name="Work · reference no longer resolves"
        note="The Case points at work that is gone. Reported, never silently omitted."
      >
        <WorkSection coordination={WORK_REFERENCE_DANGLING} />
      </State>

      <State
        name="Monitoring · inconclusive"
        note="The default today, because the measurement seam is unwired. It must not look like success."
      >
        <div className="rv-inline">
          <StateBadge state={MONITORING_INCONCLUSIVE.verdict} />
          <NotKnown lines={[...MONITORING_INCONCLUSIVE.explanation]} title="Why Loop could not judge it" />
        </div>
      </State>

      <State name="Monitoring · held" note="A criterion committed to in advance, met on adequate evidence.">
        <div className="rv-inline">
          <StateBadge state={MONITORING_HELD.verdict} />
          <ul className="cw-mon__expl">
            {MONITORING_HELD.explanation.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      </State>

      <State
        name="Outcome · recovered, cause not established"
        note="The most important outcome shape in the product. A recovery observed, and an explicit refusal to attribute it."
      >
        <OutcomeSection outcome={OUTCOME_RECOVERED_NO_CAUSE} />
      </State>

      <State
        name="Outcome · nothing established"
        note="Closed, and Loop could establish very little. Also a real result."
      >
        <OutcomeSection outcome={OUTCOME_UNESTABLISHED} />
      </State>

      <State
        name="Learning · one observation"
        note="One Case. An anecdote, and it says so."
      >
        <PatternCard pattern={PATTERN_OBSERVATION} />
      </State>

      <State
        name="Learning · emerging pattern"
        note="Four comparable Cases. Worth a person looking at — and still not doctrine, at any count."
      >
        <PatternCard pattern={PATTERN_EMERGING} />
      </State>

      {/*
        FINDINGS ON TWO AXES THAT NEVER SHARE A WORD. What the evidence supports
        and what a person decided are independent, so all four combinations are
        ordinary and each is shown. Every one comes out of the real gate over a
        real Stage 3 verdict.
      */}
      <State
        name="Finding · established, and a person accepted it"
        note="Two facts, not one. The evidence establishes it; separately, somebody agreed."
      >
        <FindingSection finding={FINDING_ESTABLISHED_ACCEPTED} />
      </State>

      <State
        name="Finding · established, and a person rejected it"
        note="Still established. Disagreeing with a claim does not weaken the evidence under it, and Loop keeps evaluating it."
      >
        <FindingSection finding={FINDING_ESTABLISHED_REJECTED} />
      </State>

      <State
        name="Finding · developing, and a person accepted it"
        note="Still developing. There is no governed standard yet for establishing a claim of this kind, and acceptance is a judgement, not evidence."
      >
        <FindingSection finding={FINDING_DEVELOPING_ACCEPTED} />
      </State>

      <State
        name="Finding · developing, and a person rejected it"
        note="Part of the window was never observed, so it would be developing whatever anybody decided. It carries the earlier claim it replaced, with that claim's own judgement."
      >
        <FindingSection finding={FINDING_DEVELOPING_REJECTED} />
      </State>

      {/*
        THE INTERACTIVE STATES. Rendered with a fixture Case id, so pressing one
        of these posts to the real guarded action and lands on a not-found
        message — the action resolves the id within the organization and finds
        nothing. That is the correct behaviour and it is why this page cannot
        mutate production truth: it has no production id to name.
      */}
      <State
        name="Controls · a finding nobody has judged"
        note="Accepting or rejecting records a judgement. It does not change what the claim says, and it does not move what the evidence supports in either direction."
      >
        <FindingControls caseId={REVIEW_CASE_ID} findingId="fnd_review" judgment={null} />
      </State>

      <State
        name="Controls · a finding somebody rejected"
        note="No further verdict is offered. The claim is still the current one, and Loop keeps evaluating its evidence."
      >
        <FindingControls caseId={REVIEW_CASE_ID} findingId="fnd_review" judgment="REJECTED" />
      </State>

      <State
        name="Controls · an option, with its sequence"
        note="Unchecking a step drops it. Verbs come from the shipped vocabulary, which is why there is no 'Increase' or 'Shift'. Loop's original is kept whatever the person does."
      >
        <RecommendationControls
          caseId={REVIEW_CASE_ID}
          optionKey="relationship-first"
          actions={[
            { position: 1, verb: 'Review', statement: 'Review the settlement feed for the affected days.', intent: null },
            { position: 2, verb: 'Evaluate', statement: 'Evaluate whether one source accounts for it.', intent: null },
          ]}
          selected={false}
          dismissed={false}
        />
      </State>

      <State
        name="Controls · start watching"
        note="Every criterion is declared before the answer is known. Loop proposes none of them — a suggested threshold would be Loop marking its own homework."
      >
        <MonitoringControls caseId={REVIEW_CASE_ID} existing={null} />
      </State>

      <State
        name="Controls · correct a monitoring plan"
        note="A correction is an append. Every earlier version is kept, so what was originally said to count stays readable after the numbers are in."
      >
        <MonitoringControls
          caseId={REVIEW_CASE_ID}
          existing={{
            condition: "Buyer CEM's monetized rate",
            metric: 'MONETIZED_RATE',
            successThreshold: 0.55,
            failureThreshold: 0.35,
            observationStart: '2026-08-25T04:00:00.000Z',
            observationEnd: '2026-09-01T04:00:00.000Z',
          }}
        />
      </State>

      <State
        name="Controls · close an investigation"
        note="Recording what happened is the point. 'We acted' and 'it did not need action' are different closes, and the false-positive rate depends on the difference."
      >
        <LifecycleControls caseId={REVIEW_CASE_ID} open reopenCount={0} />
      </State>

      <State
        name="Controls · reopen one that did not hold"
        note="The earlier resolution stays on the log. A resolution that did not hold is the most informative event an investigation can carry."
      >
        <LifecycleControls caseId={REVIEW_CASE_ID} open={false} reopenCount={2} />
      </State>

      <State
        name="A read that failed"
        note="Not a governed state. Loop could not look, which is different from Loop looking and finding nothing."
      >
        <ReadError what="today's headlines" retryHref="/app/admin/review" />
      </State>
    </div>
  );
}
