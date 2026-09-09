// The morning surface, and the investigation behind each Headline.
//
// SERVER COMPONENTS ONLY. Every control is a <form> posting to a guarded server
// action, matching every other administration surface in this repository. There
// is no client JavaScript in this file and nothing here needs any.
//
// THE ATTENTION STATE GOVERNS THE PAGE, NOT THE LENGTH OF THE LIST. `AttentionView`
// arrives already decided; this renders four visibly different mornings from it
// and has no branch anywhere on `headlines.length === 0`. That is the whole
// safety property of the surface, and it is a test.
//
// EVIDENCE IS PART OF THE HEADLINE. Not a technical screen somewhere else. A
// person reading a claim can see, in the same card, how much of the window was
// measured and what the measurement will not support -- because a claim without
// its receipts is the thing this product exists not to be.
//
// PROGRESSIVE DISCLOSURE IS A <details>, NOT A ROUTE. An executive reads the
// claim and the posture. An operator opens the disclosure and finds the rule id,
// the binding version, the windows and the governed state names. Nobody has to
// navigate away to check Loop's work.

import Link from 'next/link';
import type { ReactNode } from 'react';

import type { AttentionAssessment } from '@emgloop/shared';
import { isAllClear } from '@emgloop/shared';
import type { HeadlineView } from '@emgloop/shared';

import { NotKnown, StateBadge, StateList } from '../../_loop-os/product-state';

// --- The morning ------------------------------------------------------------------------

/**
 * What a person is told before they read a single Headline.
 *
 * FOUR STATES, FOUR DIFFERENT SENTENCES, AND ONE OF THEM IS GOOD NEWS. The other
 * three are: something is here, Loop could not see everything, and nobody has
 * told Loop what to watch. Collapsing any of them into "all clear" is the defect
 * this whole surface is built to make impossible, so the state comes in decided
 * and this function does not compute it.
 */
export function AttentionBanner({ attention }: { attention: AttentionAssessment }) {
  const clear = isAllClear(attention);
  return (
    <section
      className={'hl-att hl-att--' + attention.state.toLowerCase().replace(/_/g, '-')}
      aria-labelledby="hl-att-h"
    >
      <div className="hl-att__head">
        <StateBadge state={attention.state} />
        <h2 className="hl-att__title" id="hl-att-h">
          {attention.statement}
        </h2>
      </div>

      {/* WHAT WAS ACTUALLY CHECKED. An all-clear that does not say what it looked
          at is indistinguishable from one that looked at nothing. */}
      <dl className="hl-att__counts">
        <div>
          <dt>Objectives watched</dt>
          <dd>{attention.objectivesConsidered}</dd>
        </div>
        <div>
          <dt>Measurable now</dt>
          <dd>{attention.objectivesMeasurable}</dd>
        </div>
        <div>
          <dt>Headlines</dt>
          <dd>{attention.headlineCount}</dd>
        </div>
      </dl>

      {attention.unmeasurable.length > 0 ? (
        <details className="hl-att__gap">
          <summary>
            {attention.unmeasurable.length} of {attention.objectivesConsidered} could not be
            measured
          </summary>
          <ul className="hl-att__gaplist">
            {attention.unmeasurable.map((o) => (
              <li key={o.performanceObjectiveId}>
                <span className="hl-att__objective">{o.objectiveTitle}</span>
                {/* The governed reasons, translated, with their real names kept
                    for whoever has to go and fix it. */}
                <StateList
                  technical
                  states={o.withholdings.length > 0 ? o.withholdings : [o.readiness ?? 'UNKNOWN']}
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* EMPTY ONLY ON A REAL ALL-CLEAR, which is exactly when there is nothing
          to say. Every other state carries what it could not establish. */}
      <NotKnown lines={attention.notKnown} title="What Loop could not check" />

      {clear ? null : (
        <p className="hl-att__foot">
          {attention.state === 'NOTHING_TO_CHECK' ? (
            <Link href="/app/admin/administration/objectives" className="ent-btn ent-btn--ghost">
              Set an objective
            </Link>
          ) : attention.state === 'INSUFFICIENT_COVERAGE' ? (
            <Link href="/app/admin/administration/objectives" className="ent-btn ent-btn--ghost">
              Review evidence health
            </Link>
          ) : null}
        </p>
      )}
    </section>
  );
}

// --- One Headline -------------------------------------------------------------------------

function pct(v: number | null): string {
  // Null is unknown and renders as an em dash, never as 0%.
  return v === null ? '—' : (v * 100).toFixed(1) + '%';
}

function signedPct(v: number | null): string {
  if (v === null) return '—';
  const n = v * 100;
  return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

/**
 * Why this Headline is in front of this person.
 *
 * ONLY WHAT THE CONTRACT SUPPORTS. The objective it was measured against, and
 * whether the move runs against that objective's stated direction. Loop has no
 * governed answer to "this is your account" or "you own this buyer", so this
 * says nothing of the kind -- a relevance sentence Loop cannot stand behind
 * would be the first invented fact on the most-read screen in the product.
 */
function WhyYoureSeeingIt({ headline }: { headline: HeadlineView }) {
  const m = headline.measurement;
  return (
    <div className="hl-why">
      <span className="hl-why__label">Why you're seeing it</span>
      <p className="hl-why__text">
        {headline.objectiveTitle ? (
          <>
            Measured against <strong>{headline.objectiveTitle}</strong>.{' '}
            {m.againstObjective
              ? 'This move runs against the direction that objective states.'
              : 'This move runs with the direction that objective states.'}
          </>
        ) : (
          // The objective's title is the objective's, and it may not have loaded.
          <>This was measured against a performance objective Loop could not name here.</>
        )}
      </p>
    </div>
  );
}

/**
 * The receipts, in the same card as the claim.
 *
 * COVERAGE IS THE HEADLINE NUMBER HERE. A move measured over 98% of a window and
 * the same move measured over 61% are different claims, and only one of them is
 * worth acting on this morning.
 */
function Receipts({ headline }: { headline: HeadlineView }) {
  const m = headline.measurement;
  const withheld = headline.limitations.length + headline.unknowns.length;
  return (
    <div className="hl-rec">
      <span className="hl-rec__label">The receipts</span>
      <div className="hl-rec__row">
        {/* A Headline exists only where Stage 3 said the measurement was ready,
            so its posture starts from READY and is qualified by what follows. */}
        <StateBadge state="READY" />
        <span className="hl-rec__fact">
          <span className="hl-rec__k">Coverage</span>
          <span className="hl-rec__v">{pct(m.currentCoverage)}</span>
        </span>
        <span className="hl-rec__fact">
          <span className="hl-rec__k">Calls measured</span>
          <span className="hl-rec__v">{m.currentDenominator.toLocaleString('en-US')}</span>
        </span>
        <span className="hl-rec__fact">
          <span className="hl-rec__k">Seen</span>
          <span className="hl-rec__v">
            {headline.detectionCount} {headline.detectionCount === 1 ? 'time' : 'times'}
          </span>
        </span>
        {withheld > 0 ? (
          <span className="hl-rec__caveat">
            {withheld} {withheld === 1 ? 'caveat' : 'caveats'}
          </span>
        ) : null}
      </div>
      <p className="hl-rec__basis">{m.comparisonBasis}</p>
    </div>
  );
}

/**
 * One Headline in the feed.
 *
 * `caseId` DECIDES THE ACTION AND NOTHING ELSE DOES. When an investigation
 * already exists the card offers a way into it rather than a second Investigate
 * button, because a person pressing Investigate on something already under
 * investigation should arrive somewhere useful rather than be told off.
 */
export function HeadlineCard({
  headline,
  caseId,
  investigate,
}: {
  headline: HeadlineView;
  caseId: string | null;
  investigate: ReactNode;
}) {
  const m = headline.measurement;
  return (
    <article className="hl-card" aria-labelledby={'hl-' + headline.id}>
      <header className="hl-card__head">
        <span
          className={'hl-card__dir hl-card__dir--' + (m.againstObjective ? 'against' : 'with')}
          aria-hidden="true"
        >
          {m.movement === 'DECREASE' ? '▼' : m.movement === 'INCREASE' ? '▲' : '→'}
        </span>
        <h3 className="hl-card__claim" id={'hl-' + headline.id}>
          {headline.statement}
        </h3>
      </header>

      <div className="hl-card__nums">
        <span className="hl-card__num">
          <span className="hl-card__k">{m.metricLabel}</span>
          <span className="hl-card__v">{pct(m.currentValue)}</span>
        </span>
        <span className="hl-card__num">
          <span className="hl-card__k">Was</span>
          <span className="hl-card__v hl-card__v--quiet">{pct(m.priorValue)}</span>
        </span>
        <span className="hl-card__num">
          <span className="hl-card__k">Change</span>
          <span
            className={
              'hl-card__v hl-card__v--' + (m.againstObjective ? 'against' : 'with')
            }
          >
            {signedPct(m.percentageChange)}
          </span>
        </span>
        <span className="hl-card__num">
          <span className="hl-card__k">Window</span>
          <span className="hl-card__v hl-card__v--quiet">
            {shortDate(m.currentWindowStart)}–{shortDate(m.currentWindowEnd)}
          </span>
        </span>
      </div>

      <WhyYoureSeeingIt headline={headline} />
      <Receipts headline={headline} />

      {/* WHAT THIS MEASUREMENT WILL NOT SUPPORT, in the card. Not behind a link,
          not on a second screen. A person deciding whether to open an
          investigation needs the caveats at the moment they decide. */}
      <NotKnown
        lines={[...headline.limitations, ...headline.unknowns]}
        title="What this measurement doesn't establish"
      />

      <footer className="hl-card__foot">
        {caseId ? (
          <>
            <span className="hl-card__state">
              <StateBadge state="NEEDS_ATTENTION" />
              Already under investigation
            </span>
            <Link href={'/app/admin/cases/' + caseId} className="ent-btn ent-btn--primary">
              Open investigation
            </Link>
          </>
        ) : (
          <>
            <Link href={'/app/admin/headlines/' + headline.id} className="ent-btn ent-btn--ghost">
              Look into it
            </Link>
            {investigate}
          </>
        )}
      </footer>

      {/* THE EXPERT DISCLOSURE. Everything an operator needs to check Loop's
          work, and nothing an executive has to read. */}
      <details className="hl-card__tech">
        <summary>How Loop measured this</summary>
        <dl className="hl-tech">
          <div><dt>Rule</dt><dd>{headline.ruleId}</dd></div>
          <div><dt>Rule version</dt><dd>{headline.ruleVersion}</dd></div>
          <div><dt>Threshold</dt><dd>{headline.ruleDescription}</dd></div>
          <div><dt>Measure binding</dt><dd>{headline.measureBindingId} · v{headline.measureBindingVersion}</dd></div>
          <div><dt>Producer build</dt><dd>{headline.producerVersion}</dd></div>
          <div><dt>Current window</dt><dd>{m.currentWindowStart} → {m.currentWindowEnd}</dd></div>
          <div><dt>Prior window</dt><dd>{m.priorWindowStart} → {m.priorWindowEnd}</dd></div>
          <div><dt>Prior coverage</dt><dd>{pct(m.priorCoverage)}</dd></div>
          <div><dt>Prior denominator</dt><dd>{m.priorDenominator.toLocaleString('en-US')}</dd></div>
          <div><dt>First detected</dt><dd>{headline.firstDetectedAt}</dd></div>
          <div><dt>Last detected</dt><dd>{headline.lastDetectedAt}</dd></div>
        </dl>
      </details>
    </article>
  );
}
