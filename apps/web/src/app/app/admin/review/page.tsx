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
import { OutcomeSection, WorkSection } from '../cases/case-sections';
import { PatternCard } from './pattern-ui';

export const dynamic = 'force-dynamic';

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
          Sixteen representative states, typed as the contracts production returns. Nothing here
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

      <State
        name="A read that failed"
        note="Not a governed state. Loop could not look, which is different from Loop looking and finding nothing."
      >
        <ReadError what="today's headlines" retryHref="/app/admin/review" />
      </State>
    </div>
  );
}
