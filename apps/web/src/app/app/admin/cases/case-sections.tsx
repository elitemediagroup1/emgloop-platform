// The Case Workspace, section by section.
//
// AN INVESTIGATION ALREADY IN PROGRESS, not a form somebody has to fill out.
// Each section renders what the contract that owns it produced, and every one
// of them has an honest shape for "this Case does not have one yet" — because a
// Case on its first morning has no Finding, no recommendations and no work, and
// that is completely ordinary rather than broken.
//
// SECTIONS ARE NOT EQUAL WEIGHT. What is actionable and current sits above what
// is historical. A Case waiting on three people leads with that; a resolved one
// leads with what happened.
//
// NOTHING HERE COMPUTES A GOVERNED FACT. Every state arrives decided. The one
// thing these components do is choose the words and the shape, through the
// single translation layer.

import Link from 'next/link';
import type { ReactNode } from 'react';

import {
  CASE_CONTRIBUTION_LABELS,
  CASE_STATE_LANGUAGE,
  FACTOR_LANGUAGE,
  FACTOR_LEVEL_LANGUAGE,
  FINDING_STATE_LANGUAGE,
  POSTURE_LANGUAGE,
  type CaseBriefView,
  type CaseCoordinationView,
  type CaseDimension,
  type CaseFindingView,
  type CaseOutcomeView,
  type CaseParticipationView,
  type FactorLevel,
} from '@emgloop/shared';
import type { CaseRecommendationsView } from '@emgloop/database';

import { NotKnown, StateBadge } from '../../_loop-os/product-state';

function Section({
  title,
  subtitle,
  children,
  id,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  id: string;
}) {
  return (
    <section className="cw-sec" aria-labelledby={id}>
      <header className="cw-sec__head">
        <h2 className="cw-sec__title" id={id}>{title}</h2>
        {subtitle ? <p className="cw-sec__sub">{subtitle}</p> : null}
      </header>
      {children}
    </section>
  );
}

/** An honest absence. Never "none found", which implies Loop looked and cleared it. */
function NotYet({ line }: { line: string }) {
  return <p className="cw-notyet">{line}</p>;
}

// --- The 5Ws ------------------------------------------------------------------------------

const DIMENSION_TITLES: Record<CaseDimension, string> = {
  WHO: 'Who',
  WHAT: 'What',
  WHEN: 'When',
  WHERE: 'Where',
  WHY: 'Why',
};

/**
 * The five questions, including the ones Loop cannot answer.
 *
 * AN EMPTY WHY IS A SUCCESSFUL PRODUCT STATE. Loop derives the 5Ws from evidence
 * and the timeline; nothing in this platform infers a cause. When the contract
 * says a dimension is structurally unavailable it supplies the sentence, and
 * that sentence is rendered instead of an empty list — so a missing piece looks
 * like a missing piece rather than like an oversight.
 */
export function FiveWs({ brief }: { brief: CaseBriefView }) {
  const dims: CaseDimension[] = ['WHO', 'WHAT', 'WHEN', 'WHERE', 'WHY'];
  return (
    <Section
      id="cw-5ws"
      title="The five questions"
      subtitle="Derived from evidence and the log. Loop answers what it can and says when it cannot."
    >
      <dl className="cw-5ws">
        {dims.map((d) => {
          const key = d.toLowerCase() as 'who' | 'what' | 'when' | 'where' | 'why';
          const items = brief.fiveWs[key];
          const unavailable = brief.fiveWs.unavailable[d];
          return (
            <div key={d} className={'cw-5ws__row' + (items.length === 0 ? ' cw-5ws__row--empty' : '')}>
              <dt>{DIMENSION_TITLES[d]}</dt>
              <dd>
                {items.length > 0 ? (
                  <ul className="cw-5ws__list">
                    {items.map((i) => (
                      <li key={i.key}>
                        <span className="cw-5ws__label">{i.label}</span>
                        <span className="cw-5ws__from">from {i.derivedFrom.toLowerCase()}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  // THE STRUCTURAL REASON, when the contract states one. Never a
                  // generated explanation, and never a blank that reads as done.
                  <p className="cw-5ws__unavailable">
                    {unavailable ??
                      'Nothing on this investigation answers this yet.'}
                  </p>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </Section>
  );
}

// --- The Finding ---------------------------------------------------------------------------

/**
 * What Loop currently claims, and whether the evidence establishes it.
 *
 * ESTABLISHED IS RE-DERIVED ON EVERY READ AND THE UI SAYS SO. It is not a stored
 * flag and it can weaken: the same claim reads ESTABLISHED under a clean verdict
 * and DEVELOPING under a degraded one with nothing written in between. A surface
 * that cached it as permanent product truth would be the one place that lie
 * could enter.
 *
 * ESTABLISHED IS NOT ACCEPTED. Human acceptance is a separate act with its own
 * word, and the two never share a badge.
 */
export function FindingSection({
  finding,
  controls,
}: {
  finding: CaseFindingView | null;
  /**
   * The human judgement controls, supplied by the guarded page.
   *
   * PASSED IN, NEVER BUILT HERE. A section that constructed its own form could
   * offer authority the page has not checked for, and this file is rendered in
   * tests with no session at all.
   */
  controls?: ReactNode;
}) {
  if (!finding) {
    return (
      <Section id="cw-finding" title="What Loop concludes">
        {/* NOT "no issue found". Loop has not finished forming a claim, which is
            a different fact from having cleared the situation. */}
        <NotYet line="Loop is still developing a finding on this investigation." />
      </Section>
    );
  }

  const established = finding.state === 'ESTABLISHED';
  const label = FINDING_STATE_LANGUAGE[finding.state];

  return (
    <Section id="cw-finding" title="What Loop concludes">
      <div className="cw-find">
        <div className="cw-find__head">
          <StateBadge state={finding.state} />
          <p className="cw-find__claim">{finding.claim}</p>
        </div>
        {label ? <p className="cw-find__what">{label.detail}</p> : null}

        {finding.conclusion ? (
          <p className="cw-find__conclusion">{finding.conclusion}</p>
        ) : null}

        <dl className="cw-find__meta">
          <div>
            <dt>Basis</dt>
            <dd>
              {established
                ? finding.establishedBy === 'HUMAN_ACCEPTANCE'
                  ? 'A person accepted this claim.'
                  : 'The evidence meets the governed standard on its own.'
                : 'Not established.'}
            </dd>
          </div>
          <div>
            <dt>Supporting evidence</dt>
            <dd>{finding.supporting.length}</dd>
          </div>
          {finding.supportingWindowStart ? (
            <div>
              <dt>Window</dt>
              <dd>
                {finding.supportingWindowStart.slice(0, 10)} →{' '}
                {finding.supportingWindowEnd?.slice(0, 10) ?? '—'}
              </dd>
            </div>
          ) : null}
        </dl>

        {/* WHY IT IS NOT ESTABLISHED, in the gate's own refusals. A developing
            finding whose obstacles are invisible is just a weaker claim; naming
            them is what makes it useful. */}
        {!established && finding.establishment.reasons.length > 0 ? (
          <NotKnown
            title="What stands between this and being established"
            lines={finding.establishment.reasons.map(
              (r) => FINDING_REASON_TEXT[r] ?? r,
            )}
          />
        ) : null}

        {finding.lineage.length > 0 ? (
          <details className="cw-find__lineage">
            <summary>
              {finding.lineage.length} earlier{' '}
              {finding.lineage.length === 1 ? 'claim' : 'claims'} on this investigation
            </summary>
            <ol className="cw-lineage">
              {finding.lineage.map((l) => (
                <li key={l.findingId}>
                  {/* HISTORY IS NEVER VISUALLY REWRITTEN. The earlier claim
                      appears in its own words, with when it stood and what
                      replaced it. */}
                  <p className="cw-lineage__claim">{l.claim}</p>
                  <p className="cw-lineage__meta">
                    <StateBadge state={l.state} />
                    <span>Recorded {l.createdAt.slice(0, 10)}</span>
                    {/* WHAT REPLACED IT, by id. The contract records which
                        claim superseded this one, not when — and inventing a
                        date would be the surface adding a fact. */}
                    {l.supersededById ? <span>Replaced by a later claim</span> : null}
                  </p>
                </li>
              ))}
            </ol>
          </details>
        ) : null}

        {controls ? <div className="cw-find__controls">{controls}</div> : null}

        <details className="cw-find__tech">
          <summary>How Loop decided this</summary>
          <dl className="cw-tech">
            <div><dt>Rule version</dt><dd>{finding.establishment.ruleVersion}</dd></div>
            <div><dt>Claim kind</dt><dd>{finding.claimKind}</dd></div>
            <div><dt>Generated by</dt><dd>{finding.generatedBy}</dd></div>
            <div><dt>State</dt><dd>{finding.state}</dd></div>
            {finding.establishment.readinessWithholdings.length > 0 ? (
              <div>
                <dt>Readiness withheld</dt>
                <dd>{finding.establishment.readinessWithholdings.join(', ')}</dd>
              </div>
            ) : null}
          </dl>
        </details>
      </div>
    </Section>
  );
}

/**
 * The gate's refusals, in a person's words.
 *
 * A LOOKUP, NOT A SENTENCE GENERATOR. Every key is a governed
 * `FindingIneligibilityReason`; an unmapped one renders its own name rather than
 * a soothing paraphrase.
 */
const FINDING_REASON_TEXT: Record<string, string> = {
  NOT_LIVE: 'This claim is no longer the current one on the investigation.',
  NO_READINESS_VERDICT: 'Loop could not obtain a measurement verdict for what this claim rests on.',
  READINESS_NOT_READY: 'The measurement behind this claim is not currently ready.',
  NO_SUPPORTING_EVIDENCE: 'No evidence has been attached to this claim.',
  EVIDENCE_CONTRADICTS: 'Two pieces of evidence disagree about this.',
  EVIDENCE_INCOMPLETE: 'Part of the evidence population did not report.',
  COMPLETENESS_UNSTATED: 'The evidence does not say how much of the population reported.',
  WINDOW_NOT_STATED: 'The claim does not say which period it is about.',
  HUMAN_REJECTED: 'A person judged this claim wrong.',
  SUPERSEDED_BY_NEWER: 'A newer claim replaced this one.',
  EXPIRED_UNRESOLVED: 'It aged out before anybody established or rejected it.',
  NON_MEASUREMENT_CLAIM: 'This claim is not measurement-backed, so the measurement gate cannot establish it.',
};

// --- Recommendations ---------------------------------------------------------------------------

function FactorRow({ factor, level, basis }: { factor: string; level: FactorLevel; basis: string | null }) {
  const f = FACTOR_LANGUAGE[factor as keyof typeof FACTOR_LANGUAGE];
  const l = FACTOR_LEVEL_LANGUAGE[level];
  return (
    <div className={'cw-fac cw-fac--' + level.toLowerCase()}>
      <span className="cw-fac__name" title={f?.detail}>{f?.label ?? factor}</span>
      <span className="cw-fac__level">{l.label}</span>
      {/* A LEVEL WITH NO STATED BASIS IS A NUMBER WEARING A WORD. The contract
          requires one for anything but UNKNOWN, and this shows it. */}
      <span className="cw-fac__basis">{basis ?? l.detail}</span>
    </div>
  );
}

/**
 * Several viable responses, ranked and explained — never one right answer.
 *
 * THE RANK IS DECLARED, NOT SCORED. There is no weighting and no number, and the
 * reason one option sits above another is a pairwise comparison over the
 * declared factors that a person can read and disagree with. A score would be a
 * judgement nobody can reconstruct.
 *
 * THE MACHINE'S VERSION IS ALWAYS PRESENT. A human revision appears beside what
 * Loop proposed, never instead of it.
 */
export function RecommendationsSection({
  recommendations,
  controls,
}: {
  recommendations: CaseRecommendationsView | null;
  controls?: (optionKey: string) => ReactNode;
}) {
  if (!recommendations || recommendations.options.length === 0) {
    return (
      <Section id="cw-recs" title="Ways to respond">
        <NotYet line="Loop has not recorded any options for this investigation yet." />
      </Section>
    );
  }

  return (
    <Section
      id="cw-recs"
      title="Ways to respond"
      subtitle="Options for a person to weigh. Nothing here has been approved or acted on."
    >
      <p className="cw-recs__ceiling">
        <StateBadge state={recommendations.findingStateAtIssue} />
        <span>
          What Loop is willing to propose is capped by how strong the evidence was when these were
          written. Stronger evidence permits more committing options; weaker evidence does not.
        </span>
      </p>

      <ol className="cw-recs">
        {recommendations.options.map((o) => (
          <li key={o.key} className="cw-rec">
            <header className="cw-rec__head">
              <span className="cw-rec__rank" aria-label={'Ranked ' + o.rank}>
                {o.rank}
              </span>
              <div className="cw-rec__id">
                <h3 className="cw-rec__label">{o.label}</h3>
                <StateBadge state={o.posture} />
              </div>
            </header>
            <p className="cw-rec__summary">{o.summary}</p>

            {o.actions.length > 0 ? (
              <ol className="cw-seq">
                {[...o.actions]
                  .sort((a, b) => a.position - b.position)
                  .map((a) => (
                    <li key={a.position} className="cw-seq__step">
                      <span className="cw-seq__n" aria-hidden="true">{a.position}</span>
                      <span className="cw-seq__body">
                        <span className="cw-seq__stmt">{a.statement}</span>
                        {a.intent ? <span className="cw-seq__intent">{a.intent}</span> : null}
                      </span>
                    </li>
                  ))}
              </ol>
            ) : (
              <p className="cw-rec__nosteps">This option is a position, not a sequence of steps.</p>
            )}

            <div className="cw-rec__factors">
              {o.factors.map((f) => (
                <FactorRow key={f.factor} factor={f.factor} level={f.level} basis={f.basis} />
              ))}
            </div>

            {/* WHAT A PERSON REVISED, BESIDE WHAT LOOP PROPOSED. Never instead of. */}
            {o.revision ? (
              <div className="cw-rec__revision">
                <h4>A person revised this</h4>
                <ol className="cw-seq cw-seq--revised">
                  {[...o.revision.actions]
                    .sort((a, b) => a.position - b.position)
                    .map((a) => (
                      <li key={a.position} className="cw-seq__step">
                        <span className="cw-seq__n" aria-hidden="true">{a.position}</span>
                        <span className="cw-seq__body">
                          <span className="cw-seq__stmt">{a.statement}</span>
                        </span>
                      </li>
                    ))}
                </ol>
                <p className="cw-rec__kept">
                  Loop's original sequence is kept above, unchanged.
                </p>
              </div>
            ) : null}

            <footer className="cw-rec__foot">
              {o.selectedAt ? (
                <span className="cw-rec__chosen">
                  <StateBadge state="READY" />
                  Selected {o.selectedAt.slice(0, 10)}
                </span>
              ) : o.dismissed ? (
                <span className="cw-rec__setaside">Set aside. Loop keeps it as written.</span>
              ) : null}
              {controls?.(o.key)}
            </footer>
          </li>
        ))}
      </ol>

      {/* WHY THIS ONE IS FIRST, from the declared factors. Including the factors
          that could not be compared, because "we did not assess relationship
          risk on either option" is exactly what a person needs before trusting
          an order. */}
      {recommendations.comparisons.length > 0 ? (
        <details className="cw-recs__why">
          <summary>Why they are in this order</summary>
          <ul className="cw-cmp">
            {recommendations.comparisons.map((c) => (
              <li key={c.leftKey + '/' + c.rightKey}>
                <p className="cw-cmp__pair">
                  <strong>{c.leftKey}</strong> over <strong>{c.rightKey}</strong>
                </p>
                {c.favouringLeft.length > 0 ? (
                  <p className="cw-cmp__for">
                    Better on:{' '}
                    {c.favouringLeft
                      .map((f) => FACTOR_LANGUAGE[f.factor]?.label ?? f.factor)
                      .join(', ')}
                  </p>
                ) : null}
                {c.favouringRight.length > 0 ? (
                  <p className="cw-cmp__against">
                    Worse on:{' '}
                    {c.favouringRight
                      .map((f) => FACTOR_LANGUAGE[f.factor]?.label ?? f.factor)
                      .join(', ')}
                  </p>
                ) : null}
                {c.incomparable.length > 0 ? (
                  <p className="cw-cmp__unknown">
                    Not compared, because neither option assessed:{' '}
                    {c.incomparable.map((f) => FACTOR_LANGUAGE[f]?.label ?? f).join(', ')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {recommendations.supersededSets.length > 0 ? (
        <details className="cw-recs__prior">
          <summary>
            {recommendations.supersededSets.length} earlier set
            {recommendations.supersededSets.length === 1 ? '' : 's'} of options
          </summary>
          {recommendations.supersededSets.map((s) => (
            <div key={s.setNumber} className="cw-prior">
              <h4>Set {s.setNumber}</h4>
              <ul>
                {s.options.map((o) => (
                  <li key={o.key}>
                    {o.label} — {o.summary}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      ) : null}
    </Section>
  );
}

// --- Participation ---------------------------------------------------------------------------

/**
 * Who is involved, and what each of them is being asked for.
 *
 * BEING ASKED IS NOT BEING ASSIGNED WORK, and the section says so in words. A
 * Case can involve three people for three different reasons with no work item
 * anywhere, and collapsing that into one fake owner would lose the entire point
 * of the contract.
 */
export function ParticipationSection({
  participation,
  controls,
  releaseControl,
}: {
  participation: CaseParticipationView | null;
  /** The "ask somebody" form, supplied by the guarded page. */
  controls?: ReactNode;
  /** One release control per active participant, keyed by who and what. */
  releaseControl?: (userId: string, contribution: string) => ReactNode;
}) {
  if (!participation || participation.participants.length === 0) {
    return (
      <Section id="cw-people" title="Who is involved">
        <NotYet line="Nobody has been asked to contribute to this investigation yet." />
        {controls ? <div className="cw-people__add">{controls}</div> : null}
      </Section>
    );
  }
  return (
    <Section
      id="cw-people"
      title="Who is involved"
      subtitle="What each person is being asked for. Being asked is not being assigned work — nothing here creates a task."
    >
      <ul className="cw-people">
        {participation.participants.map((p) => (
          <li key={p.id} className={'cw-person' + (p.awaited ? ' cw-person--awaited' : '')}>
            <div className="cw-person__head">
              <span className="cw-person__who">{p.userId}</span>
              <span className="cw-person__ask">{CASE_CONTRIBUTION_LABELS[p.contribution]}</span>
              {p.awaited ? <span className="cw-person__wait">Waiting on them</span> : null}
            </div>
            <p className="cw-person__req">{p.request}</p>
            <p className="cw-person__meta">Asked {p.addedAt.slice(0, 10)}</p>
            {releaseControl ? (
              <div className="cw-person__act">{releaseControl(p.userId, p.contribution)}</div>
            ) : null}
          </li>
        ))}
      </ul>

      {controls ? <div className="cw-people__add">{controls}</div> : null}

      {participation.released.length > 0 ? (
        <details className="cw-people__released">
          <summary>
            {participation.released.length} released
          </summary>
          <ul className="cw-people cw-people--quiet">
            {participation.released.map((p) => (
              <li key={p.id} className="cw-person">
                <div className="cw-person__head">
                  <span className="cw-person__who">{p.userId}</span>
                  <span className="cw-person__ask">{CASE_CONTRIBUTION_LABELS[p.contribution]}</span>
                </div>
                {/* WHAT THEY WERE ASKED FOR IS KEPT. Who was asked is history. */}
                <p className="cw-person__req">{p.request}</p>
                <p className="cw-person__meta">Released {p.releasedAt?.slice(0, 10)}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}

// --- Work coordination ---------------------------------------------------------------------------

/**
 * Where the work stands — read from Work OS, owned by Work OS.
 *
 * NOTHING HERE IS A COPY. Every execution value is derived at read time by the
 * layer that owns it. An unmeasured obligation says so; it is never called on
 * track. An escalation-eligible one with no recipient says that too, because
 * naming a manager this platform cannot identify would move real accountability
 * onto somebody who never accepted it.
 */
export function WorkSection({ coordination }: { coordination: CaseCoordinationView | null }) {
  if (!coordination || coordination.work.length === 0) {
    return (
      <Section id="cw-work" title="What is happening">
        <NotYet line="This investigation has not produced any work yet." />
      </Section>
    );
  }
  return (
    <Section
      id="cw-work"
      title="What is happening"
      subtitle="Execution state is read from Work OS. Commercial Intelligence does not own or copy it."
    >
      <ul className="cw-work">
        {coordination.work.map((w) => (
          <li key={w.observationId} className="cw-wi">
            <div className="cw-wi__head">
              {w.execution ? (
                <>
                  <StateBadge state={w.execution.state} />
                  <StateBadge state={w.execution.sla} />
                  <span className="cw-wi__name">{w.execution.stageName}</span>
                </>
              ) : (
                <>
                  {/* THREE DIFFERENT UNREADABLE STATES, each with its own word. */}
                  <StateBadge state={w.unknown === 'NOT_MEASURED' ? 'UNKNOWN' : 'INSUFFICIENT_COVERAGE'} />
                  <span className="cw-wi__name">
                    {w.unknown === 'WORK_NOT_FOUND'
                      ? 'Loop cannot find the work this points at.'
                      : w.unknown === 'SYSTEM_NOT_READABLE'
                        ? 'This work lives in a system Loop cannot read.'
                        : 'Loop has no execution history for this work.'}
                  </span>
                </>
              )}
            </div>

            {w.execution ? (
              <>
                <dl className="cw-wi__facts">
                  <div><dt>Owner</dt><dd>{w.execution.ownerUserId ?? 'Unassigned'}</dd></div>
                  <div>
                    <dt>Expected by</dt>
                    {/* NULL IS UNKNOWN, NOT "no deadline is fine". */}
                    <dd>{w.execution.dueAt ? w.execution.dueAt.slice(0, 10) : '—'}</dd>
                  </div>
                  <div>
                    <dt>Actionable for</dt>
                    <dd>{Math.round(w.execution.durations.actionableMs / 3_600_000)}h</dd>
                  </div>
                  {w.execution.extensions > 0 ? (
                    <div>
                      <dt>Pushed</dt>
                      <dd>
                        {w.execution.extensions}{' '}
                        {w.execution.extensions === 1 ? 'time' : 'times'}
                      </dd>
                    </div>
                  ) : null}
                </dl>

                {w.execution.waiting ? (
                  <p className="cw-wi__waiting">
                    <strong>Waiting on {w.execution.waiting.subject ?? 'something unnamed'}.</strong>{' '}
                    {w.execution.waiting.expectedResolutionAt
                      ? 'Expected to clear by ' +
                        w.execution.waiting.expectedResolutionAt.slice(0, 10) +
                        '.'
                      : 'No expected resolution time was given.'}
                  </p>
                ) : null}

                {w.blockers.length > 0 ? (
                  <ul className="cw-wi__blockers">
                    {w.blockers.map((b) => (
                      <li key={b.id}>
                        <span className="cw-wi__blocked">Blocked by</span> {b.description}
                        {b.expectedResolutionAt ? (
                          <span className="cw-wi__eta">
                            {' '}Expected {b.expectedResolutionAt.slice(0, 10)}
                          </span>
                        ) : (
                          <span className="cw-wi__eta"> No expected resolution.</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}

                {/* ELIGIBLE, WITH NO RECIPIENT. Said out loud rather than hidden. */}
                {w.execution.escalationEligible ? (
                  <p className="cw-wi__escalate">
                    <strong>Eligible for escalation.</strong>{' '}
                    {w.execution.escalationDestinationUserId
                      ? 'To ' + w.execution.escalationDestinationUserId + '.'
                      : 'Loop cannot determine who this should go to: no reporting relationship is ' +
                        'configured in this platform. A role is a permission level, not a manager.'}
                  </p>
                ) : null}

                <details className="cw-wi__why">
                  <summary>How Loop worked this out</summary>
                  <ul className="cw-wi__expl">
                    {w.execution.explanation.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </details>
              </>
            ) : null}
          </li>
        ))}
      </ul>

      <NotKnown lines={coordination.notKnown} title="What Loop could not read" />
    </Section>
  );
}

// --- Outcome ---------------------------------------------------------------------------------

/**
 * What happened afterwards — and, explicitly, not why.
 *
 * `causalClaim` IS ALWAYS NULL AND THE ABSENCE IS RENDERED. A person reading
 * that Loop observed a recovery and cannot attribute it has learned something
 * real. Hiding the caveat would turn a careful result into an implied claim.
 */
export function OutcomeSection({ outcome }: { outcome: CaseOutcomeView | null }) {
  if (!outcome || (outcome.outcome === null && outcome.lineage.monitoringVerdict === null)) {
    return (
      <Section id="cw-outcome" title="What happened">
        <NotYet line="Nothing has been recorded about what happened after this investigation yet." />
      </Section>
    );
  }
  return (
    <Section id="cw-outcome" title="What happened">
      <p className="cw-out__statement">{outcome.statement}</p>

      {outcome.measuredEffectCents !== null ? (
        <dl className="cw-out__measured">
          <div>
            <dt>Measured effect</dt>
            <dd>${Math.round(outcome.measuredEffectCents / 100).toLocaleString('en-US')}</dd>
          </div>
          {outcome.measuredEffectBasis ? (
            <div><dt>Basis</dt><dd>{outcome.measuredEffectBasis}</dd></div>
          ) : null}
        </dl>
      ) : null}

      {/* THE REFUSAL, RENDERED. Not a footnote and not omitted. */}
      <p className="cw-out__caveat">
        <span className="cw-out__caveatlabel">What this does not establish</span>
        {outcome.causalCaveat}
      </p>

      <NotKnown lines={outcome.notEstablished} title="What Loop could not establish" />

      <details className="cw-out__lineage">
        <summary>What this outcome descends from</summary>
        <dl className="cw-tech">
          <div><dt>Finding</dt><dd>{outcome.lineage.findingId ?? '—'}</dd></div>
          <div>
            <dt>Options recorded</dt>
            <dd>{outcome.lineage.recommendationDecisionIds.length}</dd>
          </div>
          <div>
            <dt>Selected</dt>
            <dd>{outcome.lineage.selectedRecommendationDecisionId ?? 'None'}</dd>
          </div>
          <div>
            <dt>Work referenced</dt>
            <dd>{outcome.lineage.workReferences.length}</dd>
          </div>
          <div>
            <dt>Monitoring window</dt>
            <dd>
              {outcome.lineage.monitoringWindow
                ? outcome.lineage.monitoringWindow.start.slice(0, 10) +
                  ' → ' +
                  outcome.lineage.monitoringWindow.end.slice(0, 10)
                : '—'}
            </dd>
          </div>
          <div>
            <dt>Evidence rows</dt>
            <dd>{outcome.lineage.evidenceIds.length}</dd>
          </div>
        </dl>
      </details>
    </Section>
  );
}

// --- Timeline ------------------------------------------------------------------------------------

/**
 * Everything that happened, in order, including the things that did not hold.
 *
 * A RESOLUTION THAT WAS REOPENED STAYS ON THE LOG. That is the most informative
 * event a Case can carry, and a timeline that tidied it away would be the
 * product forgetting its own mistakes.
 */
export function TimelineSection({ brief }: { brief: CaseBriefView }) {
  if (brief.timeline.length === 0) {
    return (
      <Section id="cw-history" title="History">
        <NotYet line="Nothing has been recorded on this investigation yet." />
      </Section>
    );
  }
  return (
    <Section id="cw-history" title="History">
      <ol className="cw-time">
        {brief.timeline.map((t) => (
          <li key={t.id} className={'cw-time__row cw-time__row--' + t.actorType.toLowerCase()}>
            <span className="cw-time__when">{t.occurredAt.slice(0, 16).replace('T', ' ')}</span>
            <span className="cw-time__what">
              <span className="cw-time__type">{t.type.replace(/_/g, ' ').toLowerCase()}</span>
              {t.reason ? <span className="cw-time__reason">{t.reason}</span> : null}
              {t.note ? <span className="cw-time__note">{t.note}</span> : null}
              <span className="cw-time__who">
                {t.actorType === 'HUMAN' ? (t.actorUserId ?? 'a person') : 'Loop'}
                {t.previousState && t.newState ? (
                  <>
                    {' · '}
                    {CASE_STATE_LANGUAGE[t.previousState]?.label ?? t.previousState} →{' '}
                    {CASE_STATE_LANGUAGE[t.newState]?.label ?? t.newState}
                  </>
                ) : null}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
