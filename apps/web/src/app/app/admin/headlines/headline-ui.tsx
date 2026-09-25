// The Headlines workspace, and the investigation behind each Headline.
//
// SERVER COMPONENTS ONLY. Every control is a <form> posting to a guarded server
// action, supplied by the page and never built here, matching every other
// administration surface in this repository. There is no client JavaScript in
// this file and nothing here needs any.
//
// THE ATTENTION STATE GOVERNS THE PAGE, NOT THE LENGTH OF THE LIST. `AttentionView`
// arrives already decided; this renders four visibly different mornings from it
// and has no branch anywhere on `headlines.length === 0`. That is the whole
// safety property of the surface, and it is a test.
//
// WHERE A HEADLINE STANDS IS DERIVED, NEVER STORED. `headlineSituation()` in
// `@emgloop/shared` reads two records that already exist -- the Headline (open,
// or set aside with a basis) and the Case opened from it (its lane, its outcome,
// when it closed) -- and answers on every render. Nothing here is a Headline
// state, and the card offers a decision ONLY while the projection says nobody has
// made one: a set-aside or investigated Headline renders its record and its
// links, and drops whatever controls the page passed.
//
// ONE LIST, THREE SECTIONS, NOTHING ARCHIVED. Current, under investigation and
// history are three places in the same list. A resolved, dismissed or set-aside
// Headline is history the workspace keeps and shows; a filter expands a section,
// it never removes one.
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

import type {
  AttentionAssessment,
  CaseStandingInput,
  HeadlineSection,
  HeadlineSituation,
  HeadlineView,
  TimeView,
} from '@emgloop/shared';
import {
  BUSINESS_TIME_ZONE,
  HEADLINE_DISMISSAL_BASES,
  HEADLINE_DISMISSAL_BASIS_HELP,
  HEADLINE_DISMISSAL_BASIS_LABELS,
  caseOutcomeLabel,
  formatInstant,
  headlineAcceptsDecision,
  headlineSection,
  headlineSituation,
  headlineSituationLabel,
  isAllClear,
} from '@emgloop/shared';

import { LabelBadge, NotKnown, StateBadge, StateList } from '../../_loop-os/product-state';

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

// --- Where a Headline stands ------------------------------------------------------------------

/**
 * The Case behind a Headline, as the workspace reads it: which thread, and the
 * lane, outcome and close time the Decision Center projects from its own log.
 *
 * SHAPED AS THE SHARED PROJECTION'S INPUT plus an id, so the database's
 * `HeadlineCaseLifecycle` satisfies it structurally and nothing here names a
 * database type.
 */
export interface HeadlineCaseRef extends CaseStandingInput {
  caseId: string;
}

/** One Headline, its Case if any, and where the two together put it. */
export interface HeadlineEntry {
  headline: HeadlineView;
  kase: HeadlineCaseRef | null;
  situation: HeadlineSituation;
}

export interface HeadlineSections {
  current: HeadlineEntry[];
  investigating: HeadlineEntry[];
  history: HeadlineEntry[];
}

/**
 * The list, sorted into its three sections by the derived situation.
 *
 * ORDER IS PRESERVED WITHIN A SECTION. The repository orders by when a
 * development was last confirmed, and nothing here re-ranks; a Headline missing
 * from `cases` has no investigation, which is a real answer and not a gap.
 */
export function sectionHeadlines(
  headlines: readonly HeadlineView[],
  cases: ReadonlyMap<string, HeadlineCaseRef>,
): HeadlineSections {
  const out: HeadlineSections = { current: [], investigating: [], history: [] };
  for (const headline of headlines) {
    const kase = cases.get(headline.id) ?? null;
    const situation = headlineSituation(headline, kase);
    const entry: HeadlineEntry = { headline, kase, situation };
    const section = headlineSection(situation);
    if (section === 'CURRENT') out.current.push(entry);
    else if (section === 'INVESTIGATING') out.investigating.push(entry);
    else out.history.push(entry);
  }
  return out;
}

/**
 * The `show` filter: which section a person asked to have open.
 *
 * A CLOSED SET, and an unrecognised value is the default rather than an error --
 * a stale link should land on the workspace, not on a complaint. Null is the
 * default view: current and under investigation open, history collapsed.
 */
export const HEADLINE_SHOW = ['current', 'investigating', 'history', 'all'] as const;
export type HeadlineShow = (typeof HEADLINE_SHOW)[number] | null;

export function parseShow(raw: string | string[] | undefined): HeadlineShow {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && (HEADLINE_SHOW as readonly string[]).includes(value) ? (value as HeadlineShow) : null;
}

/**
 * Which sections start open. Every section is ALWAYS rendered; a filter only
 * decides what a person sees without clicking.
 */
export function expandedSections(show: HeadlineShow): Record<HeadlineSection, boolean> {
  switch (show) {
    case 'current':
      return { CURRENT: true, INVESTIGATING: false, HISTORY: false };
    case 'investigating':
      return { CURRENT: false, INVESTIGATING: true, HISTORY: false };
    case 'history':
      return { CURRENT: false, INVESTIGATING: false, HISTORY: true };
    case 'all':
      return { CURRENT: true, INVESTIGATING: true, HISTORY: true };
    default:
      return { CURRENT: true, INVESTIGATING: true, HISTORY: false };
  }
}

/** The workspace URL for a filter and an objective scope. Both optional; both the repository's own options. */
export function workspaceHref(show: HeadlineShow, objectiveId: string | null): string {
  const params = new URLSearchParams();
  if (show) params.set('show', show);
  if (objectiveId) params.set('objective', objectiveId);
  const query = params.toString();
  return '/app/admin/headlines' + (query ? '?' + query : '');
}

/** The filter, as links. Counts beside each so nothing reads as empty by omission. */
export function HeadlineShowNav({
  show,
  counts,
  objectiveId,
}: {
  show: HeadlineShow;
  counts: { current: number; investigating: number; history: number };
  objectiveId: string | null;
}) {
  const items: Array<{ show: HeadlineShow; label: string; count: number | null }> = [
    { show: null, label: 'Open', count: counts.current + counts.investigating },
    { show: 'current', label: 'Current', count: counts.current },
    { show: 'investigating', label: 'Under investigation', count: counts.investigating },
    { show: 'history', label: 'History', count: counts.history },
    { show: 'all', label: 'All', count: null },
  ];
  return (
    <nav aria-label="Which Headlines to show">
      <ul className="hl-show">
        {items.map((item) => (
          <li key={item.label}>
            <Link
              href={workspaceHref(item.show, objectiveId)}
              className="hl-show__link"
              aria-current={item.show === show ? 'page' : undefined}
            >
              {item.label}
              {item.count !== null ? <span className="hl-show__count">{item.count}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Where one Headline stands, in one line: the governed word, then the facts
 * that word rests on.
 *
 *   Set aside · <basis> · <when> · by <who>
 *   Resolved · <outcome> · <when>
 *   Closed without acting · <outcome> · <when>
 *
 * EVERY FACT IS THE RECORD'S. The basis and the dismisser are the Headline's;
 * the outcome and the close time are the Case's. An absent fact says it is
 * absent rather than being dropped, because "resolved, no outcome recorded" and
 * "resolved, recovered" are different things to know.
 */
export function HeadlineStanding({
  headline,
  kase,
  time,
}: {
  headline: HeadlineView;
  kase: HeadlineCaseRef | null;
  time: Pick<TimeView, 'date'>;
}) {
  const situation = headlineSituation(headline, kase);
  const label = headlineSituationLabel(situation);
  const parts: string[] = [];

  if (situation === 'SET_ASIDE') {
    parts.push(
      headline.dismissalBasis
        ? HEADLINE_DISMISSAL_BASIS_LABELS[headline.dismissalBasis]
        : 'No basis recorded',
    );
    parts.push(headline.dismissedAt ? time.date(headline.dismissedAt) : 'Time not recorded');
    if (headline.dismissedByName) parts.push('by ' + headline.dismissedByName);
  } else if (kase && (situation === 'RESOLVED' || situation === 'DISMISSED_BY_INVESTIGATION')) {
    // The outcome word from the one dictionary; an outcome this build has no
    // word for renders as its governed name rather than a guess.
    parts.push(kase.outcome ? (caseOutcomeLabel(kase.outcome)?.label ?? kase.outcome) : 'No outcome recorded');
    parts.push(kase.resolvedAt ? time.date(kase.resolvedAt) : 'Close time not recorded');
  }

  return (
    <span className={'hl-stand hl-stand--' + situation.toLowerCase().replace(/_/g, '-')}>
      <LabelBadge label={label} />
      {parts.map((part, i) => (
        <span key={i} className="hl-stand__part">
          <span className="hl-stand__sep" aria-hidden="true">·</span>
          {part}
        </span>
      ))}
    </span>
  );
}

/**
 * The two reasons a person can set a Headline aside, as a fieldset the page
 * wraps in its guarded form.
 *
 * NO DEFAULT, DELIBERATELY. Which of the two a person means is the only signal
 * Loop gets about whether it earns attention, and a pre-ticked answer would
 * corrupt it.
 */
export function DismissalBasisFieldset() {
  return (
    <fieldset className="hl-acts__fs">
      <legend>Why?</legend>
      {HEADLINE_DISMISSAL_BASES.map((basis) => (
        <label key={basis} className="hl-acts__radio">
          <input type="radio" name="basis" value={basis} required />
          <span>
            <strong>{HEADLINE_DISMISSAL_BASIS_LABELS[basis]}</strong>
            <em>{HEADLINE_DISMISSAL_BASIS_HELP[basis]}</em>
          </span>
        </label>
      ))}
    </fieldset>
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

// A measurement window boundary, on the calendar the window is defined on:
// CallGrid's Eastern reporting days. It is a window's own zone, not the reader's
// (Loop Time Authority, object-owned timezone).
function shortDate(iso: string): string {
  return formatInstant(iso, BUSINESS_TIME_ZONE, 'monthDay');
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
 * THE DERIVED SITUATION DECIDES THE FOOTER, AND NOTHING ELSE DOES. While nobody
 * has decided anything, the card offers reading and whatever decision controls
 * the page passed. Once an investigation exists it offers a way into it rather
 * than a second Investigate button. Once the Headline is history -- set aside,
 * resolved, closed without acting -- it shows its record and its links, and the
 * controls the page passed are NOT rendered, whatever they were: the question
 * they answer is closed.
 */
export function HeadlineCard({
  headline,
  kase,
  investigate,
  time,
}: {
  headline: HeadlineView;
  kase: HeadlineCaseRef | null;
  investigate: ReactNode;
  time: Pick<TimeView, 'date'>;
}) {
  const m = headline.measurement;
  const situation = headlineSituation(headline, kase);
  const section = headlineSection(situation);
  return (
    <article
      className={'hl-card hl-card--' + section.toLowerCase()}
      aria-labelledby={'hl-' + headline.id}
      data-situation={situation}
    >
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
        {headlineAcceptsDecision(situation) ? (
          <>
            <Link href={'/app/admin/headlines/' + headline.id} className="ent-btn ent-btn--ghost">
              Look into it
            </Link>
            {investigate}
          </>
        ) : situation === 'UNDER_INVESTIGATION' && kase ? (
          <>
            {/* THE CASE'S OWN LANE WORD, beside the fact. Where the investigation
                stands is the investigation's to say. */}
            <span className="hl-card__state">
              Already under investigation
              <StateBadge state={kase.state} />
            </span>
            <Link href={'/app/admin/cases/' + kase.caseId} className="ent-btn ent-btn--primary">
              Open investigation
            </Link>
          </>
        ) : (
          <>
            <HeadlineStanding headline={headline} kase={kase} time={time} />
            {/* Reading is always available. History is kept, and it stays navigable. */}
            <Link href={'/app/admin/headlines/' + headline.id} className="ent-btn ent-btn--ghost">
              Look into it
            </Link>
            {kase ? (
              <Link href={'/app/admin/cases/' + kase.caseId} className="ent-btn ent-btn--ghost">
                Open investigation
              </Link>
            ) : null}
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

// --- A section of the workspace ------------------------------------------------------------

/**
 * One of the three sections: a native disclosure with the cards inside.
 *
 * ALWAYS RENDERED, WHATEVER THE FILTER. `expanded` decides whether it starts
 * open; it never decides whether it exists. An empty section says so in words
 * that defer to the banner, because whether "no current Headlines" is good news
 * is the governed attention state's call and not this list's.
 */
export function HeadlineSectionBlock({
  id,
  title,
  lead,
  entries,
  expanded,
  empty,
  time,
  controls,
}: {
  id: HeadlineSection;
  title: string;
  lead: string;
  entries: readonly HeadlineEntry[];
  expanded: boolean;
  empty: string;
  time: Pick<TimeView, 'date'>;
  /** The decision controls for one entry, from the page. Rendered only while a decision is open. */
  controls?: (entry: HeadlineEntry) => ReactNode;
}) {
  const key = id.toLowerCase();
  return (
    <details className={'hl-sec hl-sec--' + key} id={'hl-sec-' + key} open={expanded || undefined}>
      <summary className="hl-sec__head">
        <h2 className="hl-sec__title">{title}</h2>
        <span className="hl-sec__count">{entries.length}</span>
        <span className="hl-sec__lead">{lead}</span>
      </summary>
      {entries.length > 0 ? (
        <div className="hl-feed">
          {entries.map((entry) => (
            <HeadlineCard
              key={entry.headline.id}
              headline={entry.headline}
              kase={entry.kase}
              investigate={controls ? controls(entry) : null}
              time={time}
            />
          ))}
        </div>
      ) : (
        <p className="hl-sec__empty">{empty}</p>
      )}
    </details>
  );
}
