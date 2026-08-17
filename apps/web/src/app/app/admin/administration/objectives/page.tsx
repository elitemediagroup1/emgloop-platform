// Administration › Objectives — Commercial Intelligence Stage 1.
//
// The human authoring surface for Performance Objectives: what this organization
// and the people in it are trying to accomplish. It is a form and a list, and it
// is meant to stay that way.
//
// Stage 2 adds one guarded administrative action and one read-only table below
// it: run the deterministic evaluator over recorded activity, then look at what
// it concluded and why.
//
// Stage 3 v1 adds two more: choosing what Loop should measure for an objective,
// and a read-only list of the measured developments that crossed the threshold.
//
// THIS IS STILL NOT THE COMMERCIAL INTELLIGENCE EXPERIENCE. It is a validation
// and administration surface. There is no investigation workspace, no score, no
// confidence, no ranking, no chart, no recommendation, no "Investigate" and no
// "Create decision" — because none of those exist, and Charlie and Lexi own the
// experience this eventually becomes.
//
// THE SIGNALS TABLE IS AN INSPECTION SURFACE. Ordered by when the observation
// happened and by nothing else. Signals are shown NEXT TO headlines, never as
// their cause: a signal is a lexical relevance determination and it defines no
// population, no denominator and no importance.
//
// A HEADLINE IS NOT A DECISION, AND THIS PAGE MUST NOT IMPLY OTHERWISE. The only
// thing a person can do to one here is say they did not need it. There is no
// assignment, no owner, no lane and no closure — judgement and action live in the
// Decision Center, and promotion into it is Stage 3 v1.1.
//
// Server components only, same as every other administration page: every control
// is a <form> posting to a guarded server action, so authoring costs no client
// JavaScript. Reuses the existing `adm-*` design-system classes — no new CSS.

import { requirePermission, hasPermission } from '../../../../../auth/guard';
import { repositories, CALLGRID_PROVIDER, CALLS_STREAM } from '@emgloop/database';
import {
  BINDING_DIMENSION_LABELS,
  COMPARISON_SPAN_DAYS,
  HEADLINE_DISMISSAL_BASES,
  HEADLINE_DISMISSAL_BASIS_HELP,
  HEADLINE_DISMISSAL_BASIS_LABELS,
  MEASURE_DIRECTION_LABELS,
  MEASURE_DIRECTIONS,
  MEASURE_METRICS,
  MEASURE_METRIC_DEFINITIONS,
  PERFORMANCE_OBJECTIVE_SCOPE_LABELS,
  PERFORMANCE_OBJECTIVE_STATUS_LABELS,
  PERFORMANCE_OBJECTIVE_TITLE_MAX,
  NOT_MEASURABLE_INCOMPLETE_DATA,
  assessWindowObservation,
  describePopulation,
  easternBusinessDatesIn,
  easternTrailingCompleteWindows,
  formatValue,
  type HeadlineView,
  type ObjectiveMeasureBindingView,
  type PerformanceObjectiveView,
} from '@emgloop/shared';
import type { PopulationCandidateRow } from '@emgloop/database';
import {
  createObjectiveAction,
  updateObjectiveAction,
  setObjectiveStatusAction,
  evaluateActivityAction,
  confirmMeasureBindingAction,
  retireMeasureBindingAction,
  detectHeadlinesAction,
  dismissHeadlineAction,
} from './actions';

export const dynamic = 'force-dynamic';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** `YYYY-MM-DD` for `<input type="date">`, which accepts nothing else. */
function dateInputValue(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

/** Who the objective belongs to, in one phrase. */
function belongsTo(o: PerformanceObjectiveView, orgName: string): string {
  if (o.scope === 'ORGANIZATION') return orgName;
  return o.scopeUserName ?? 'A former team member';
}

/** A window boundary as a date a reader can check against a calendar. */
function fmtWindow(startIso: string, endIso: string): string {
  // The end boundary is exclusive (half-open), so the last day a reader would
  // recognise is the day before it. Showing the exclusive instant would put a
  // date in the label that the measurement did not actually include.
  const end = new Date(new Date(endIso).getTime() - 1);
  return `${fmtDate(startIso)} – ${fmtDate(end.toISOString())}`;
}

/** Coverage as a percentage, or an explicit statement that it does not apply. */
function fmtCoverage(coverage: number | null): string {
  if (coverage === null) return 'not applicable';
  return `${Math.round(coverage * 100)}%`;
}

export default async function AdminObjectivesPage({
  searchParams,
}: {
  searchParams?: { notice?: string; error?: string; show?: string };
}) {
  const session = await requirePermission('commercialIntelligence', 'view');
  const canManage = await hasPermission('commercialIntelligence', 'update');
  const canCreate = await hasPermission('commercialIntelligence', 'create');

  const objectives = await repositories.performanceObjectives.list(session.organizationId);
  // Commercial Intelligence Stage 3. Active bindings say which objectives Loop is
  // allowed to measure; an objective missing from this map is NOT MEASURABLE YET,
  // which is a real state and never an error.
  const activeBindings = await repositories.measureBindings.listActive(session.organizationId);
  const bindingByObjective = new Map<string, ObjectiveMeasureBindingView>(
    activeBindings.map((b) => [b.performanceObjectiveId, b]),
  );
  const headlines = await repositories.headlines.list(session.organizationId, { take: 50 });
  // Whether Loop actually looked at the days it would be comparing. Read here so
  // the page can say NOT MEASURABLE — INCOMPLETE DATA before somebody presses
  // Measure now, rather than only explaining afterwards why nothing happened.
  const comparisonWindows = easternTrailingCompleteWindows(new Date(), COMPARISON_SPAN_DAYS);
  const comparisonDates = [
    ...easternBusinessDatesIn(comparisonWindows.prior),
    ...easternBusinessDatesIn(comparisonWindows.current),
  ];
  const observation = assessWindowObservation(
    comparisonDates,
    await repositories.providerObservations.statusesForDates(
      session.organizationId,
      CALLGRID_PROVIDER,
      CALLS_STREAM,
      comparisonDates,
    ),
  );
  // Dimension members Loop has ACTUALLY OBSERVED, offered for selection. Only
  // members carrying a stable provider id are returned — a population keyed on a
  // label would change shape the day somebody renames a campaign upstream.
  const CANDIDATE_WINDOW_DAYS = 90;
  const candidates: PopulationCandidateRow[] = canManage
    ? await repositories.marketplaceCalls.listPopulationCandidates(
        session.organizationId,
        new Date(Date.now() - CANDIDATE_WINDOW_DAYS * 86_400_000),
      )
    : [];
  // Commercial Intelligence Stage 2. Read org-scoped, like everything else on
  // this page — the session organization is the only tenant this reads.
  const signals = await repositories.commercialSignals.list(session.organizationId, { take: 50 });
  // Truth, not a bare number: an EMPTY count means no positive determination has
  // been recorded — never that Loop examined the activity and dismissed it.
  const signalCount = await repositories.commercialSignals.count(session.organizationId);
  const totalSignals = signalCount.state === 'success' ? signalCount.value : 0;
  // The roster is needed only to name a person on a USER-scoped objective. It is
  // the org's own members, and it is read only when somebody may actually author.
  const members = canCreate || canManage
    ? await repositories.iam.listUsers(session.organizationId)
    : [];
  // The org's own row, resolved by the session id. Used only to name the tenant
  // in "belongs to" — never to widen anything.
  const org = await repositories.organizations.findById(session.organizationId);
  const orgName = org?.name ?? 'This organization';

  const active = objectives.filter((o) => o.status === 'ACTIVE');
  const archived = objectives.filter((o) => o.status === 'ARCHIVED');
  const showArchived = searchParams?.show === 'archived';

  const notice = typeof searchParams?.notice === 'string' ? searchParams.notice : null;
  const error = typeof searchParams?.error === 'string' ? searchParams.error : null;

  const memberOptions = members.map((m) => (
    <option key={m.id} value={m.id}>
      {m.name ?? m.email}
    </option>
  ));

  function ObjectiveRow({ o }: { o: PerformanceObjectiveView }) {
    return (
      <tr key={o.id}>
        <td>
          <strong>{o.title}</strong>
          {o.description ? <div className="adm-faint">{o.description}</div> : null}
        </td>
        <td>
          <span className="adm-badge">{PERFORMANCE_OBJECTIVE_SCOPE_LABELS[o.scope]}</span>
          <div className="adm-faint">{belongsTo(o, orgName)}</div>
        </td>
        <td>
          {fmtDate(o.effectiveFrom)}
          <div className="adm-faint">
            {o.effectiveTo ? `to ${fmtDate(o.effectiveTo)}` : 'no end date'}
          </div>
        </td>
        <td>
          <span className="adm-badge">{PERFORMANCE_OBJECTIVE_STATUS_LABELS[o.status]}</span>
        </td>
        {canManage ? (
          <td>
            <details className="adm-inline">
              <summary className="adm-btn">Edit</summary>
              <form action={updateObjectiveAction} className="adm-inviteform">
                <input type="hidden" name="id" value={o.id} />
                <label className="adm-field">
                  <span className="adm-field__label">Objective</span>
                  <input
                    className="adm-input"
                    name="title"
                    defaultValue={o.title}
                    maxLength={PERFORMANCE_OBJECTIVE_TITLE_MAX}
                    required
                  />
                </label>
                <label className="adm-field">
                  <span className="adm-field__label">Detail</span>
                  <input className="adm-input" name="description" defaultValue={o.description ?? ''} />
                </label>
                <label className="adm-field">
                  <span className="adm-field__label">Belongs to</span>
                  <select className="adm-input" name="scope" defaultValue={o.scope}>
                    <option value="ORGANIZATION">The organization</option>
                    <option value="USER">A person</option>
                  </select>
                </label>
                <label className="adm-field">
                  <span className="adm-field__label">Person (if scoped to a person)</span>
                  <select className="adm-input" name="scopeUserId" defaultValue={o.scopeUserId ?? ''}>
                    <option value="">— none —</option>
                    {memberOptions}
                  </select>
                </label>
                <label className="adm-field">
                  <span className="adm-field__label">Start</span>
                  <input
                    className="adm-input"
                    type="date"
                    name="effectiveFrom"
                    defaultValue={dateInputValue(o.effectiveFrom)}
                  />
                </label>
                <label className="adm-field">
                  <span className="adm-field__label">End (optional)</span>
                  <input
                    className="adm-input"
                    type="date"
                    name="effectiveTo"
                    defaultValue={dateInputValue(o.effectiveTo)}
                  />
                </label>
                <button className="adm-btn adm-btn--primary" type="submit">Save</button>
              </form>
            </details>
            <form action={setObjectiveStatusAction} className="adm-inline">
              <input type="hidden" name="id" value={o.id} />
              <input type="hidden" name="status" value={o.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE'} />
              <button className="adm-btn" type="submit">
                {o.status === 'ACTIVE' ? 'Archive' : 'Reactivate'}
              </button>
            </form>
          </td>
        ) : null}
      </tr>
    );
  }

  /**
   * One measured development.
   *
   * Everything a reader needs to answer "why is Loop telling me this?" is on the
   * row or one <details> away: the measurement, the comparison, the coverage,
   * what Loop does not know, the rule that fired, and when it was first and last
   * seen. There is no confidence percentage, no rank, no recommendation and no
   * "Investigate" — none of those exist.
   */
  function HeadlineRow({ h }: { h: HeadlineView }) {
    const m = h.measurement;
    const pct = m.percentageChange === null ? null : Math.abs(m.percentageChange * 100);
    return (
      <tr key={h.id}>
        <td>
          <strong>{h.statement}</strong>
          <div className="adm-faint">
            {/* A fact about arithmetic and the direction a person declared —
                never a claim that the business is doing well or badly. */}
            <span className="adm-badge">
              {m.againstObjective ? 'Against the objective' : 'With the objective'}
            </span>{' '}
            {h.dismissedAt ? (
              <span className="adm-badge">
                Dismissed
                {h.dismissalBasis ? `: ${HEADLINE_DISMISSAL_BASIS_LABELS[h.dismissalBasis]}` : ''}
              </span>
            ) : null}
          </div>
        </td>
        <td>{h.objectiveTitle ?? '—'}</td>
        <td>
          {MEASURE_METRIC_DEFINITIONS[m.metric].label}: {formatValue(m.priorValue, m.unit)} →{' '}
          {formatValue(m.currentValue, m.unit)}
          {pct === null ? '' : ` (${m.movement === 'INCREASE' ? '+' : '−'}${pct.toFixed(pct < 10 ? 1 : 0)}%)`}
          <div className="adm-faint">
            {fmtWindow(m.currentWindowStart, m.currentWindowEnd)} vs{' '}
            {fmtWindow(m.priorWindowStart, m.priorWindowEnd)}
          </div>
          <div className="adm-faint">
            Over {m.currentDenominator.toLocaleString('en-US')} calls now and{' '}
            {m.priorDenominator.toLocaleString('en-US')} before · coverage{' '}
            {fmtCoverage(m.currentCoverage)} and {fmtCoverage(m.priorCoverage)}
          </div>
        </td>
        <td>
          {h.ruleDescription}
          <div className="adm-faint">
            First detected {fmtDate(h.firstDetectedAt)} · last confirmed{' '}
            {fmtDate(h.lastDetectedAt)} · seen in {h.detectionCount} period
            {h.detectionCount === 1 ? '' : 's'}
          </div>
          <div className="adm-faint">
            {h.ruleId} {h.ruleVersion} · {h.producerVersion} · measure definition
            version {h.measureBindingVersion}
          </div>
          {h.limitations.length > 0 || h.unknowns.length > 0 ? (
            <details className="adm-inline">
              <summary className="adm-btn">What this cannot tell you</summary>
              <ul className="adm-faint">
                {h.limitations.map((l) => <li key={l}>{l}</li>)}
                {h.unknowns.map((u) => <li key={u}>{u}</li>)}
              </ul>
            </details>
          ) : null}
        </td>
        {canManage ? (
          <td>
            {h.dismissedAt ? (
              <span className="adm-faint">
                Dismissed {fmtDate(h.dismissedAt)}
                {h.dismissedByName ? ` by ${h.dismissedByName}` : ''}. Loop keeps
                recording whether it persists.
              </span>
            ) : (
              <details className="adm-inline">
                <summary className="adm-btn">I did not need this</summary>
                <form action={dismissHeadlineAction} className="adm-inviteform">
                  <input type="hidden" name="headlineId" value={h.id} />
                  <fieldset className="adm-field">
                    <legend className="adm-field__label">Which was it?</legend>
                    {HEADLINE_DISMISSAL_BASES.map((b) => (
                      <label key={b} className="adm-check">
                        <input type="radio" name="basis" value={b} required />{' '}
                        <span>
                          {HEADLINE_DISMISSAL_BASIS_LABELS[b]}
                          <span className="adm-faint"> — {HEADLINE_DISMISSAL_BASIS_HELP[b]}</span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <button className="adm-btn" type="submit">Record that</button>
                  <span className="adm-faint">
                    {' '}This is feedback about whether Loop earned your attention.
                    It is not a decision, and it does not stop Loop noticing if the
                    same thing keeps happening.
                  </span>
                </form>
              </details>
            )}
          </td>
        ) : null}
      </tr>
    );
  }

  return (
    <div className="adm">
      <div className="loop-pagehead">
        <div className="loop-eyebrow">Administration</div>
        <h1 className="loop-title">Objectives</h1>
        <p className="loop-subtitle">
          What this organization and the people in it are trying to accomplish.{' '}
          {active.length} active
          {archived.length ? ` · ${archived.length} archived` : ''}
        </p>
      </div>

      {error ? <div className="adm-banner adm-banner--error" role="alert">{error}</div> : null}
      {notice ? <div className="adm-banner adm-banner--ok" role="status">{notice}</div> : null}

      {canCreate ? (
        <section className="adm-card">
          <h2 className="adm-card__title">Add an objective</h2>
          <form action={createObjectiveAction} className="adm-inviteform">
            <label className="adm-field">
              <span className="adm-field__label">Objective</span>
              <input
                className="adm-input"
                name="title"
                placeholder="Grow brand-partnership revenue"
                maxLength={PERFORMANCE_OBJECTIVE_TITLE_MAX}
                required
              />
            </label>
            <label className="adm-field">
              <span className="adm-field__label">Detail</span>
              <input
                className="adm-input"
                name="description"
                placeholder="What this means, in your words"
              />
            </label>
            <label className="adm-field">
              <span className="adm-field__label">Belongs to</span>
              <select className="adm-input" name="scope" defaultValue="ORGANIZATION">
                <option value="ORGANIZATION">The organization</option>
                <option value="USER">A person</option>
              </select>
            </label>
            <label className="adm-field">
              <span className="adm-field__label">Person (if scoped to a person)</span>
              <select className="adm-input" name="scopeUserId" defaultValue="">
                <option value="">— none —</option>
                {memberOptions}
              </select>
            </label>
            <label className="adm-field">
              <span className="adm-field__label">Start</span>
              <input className="adm-input" type="date" name="effectiveFrom" />
            </label>
            <label className="adm-field">
              <span className="adm-field__label">End (optional)</span>
              <input className="adm-input" type="date" name="effectiveTo" />
            </label>
            <button className="adm-btn adm-btn--primary" type="submit">Add objective</button>
          </form>
        </section>
      ) : null}

      <section className="adm-card">
        <h2 className="adm-card__title">Active objectives</h2>
        {active.length === 0 ? (
          // An honest empty state: no objectives have been written yet, and that
          // is a real answer rather than a zero dressed as data.
          <p className="adm-faint">
            No objectives recorded yet.
            {canCreate
              ? ' Add the first one above — start with what the organization is trying to accomplish.'
              : ' An administrator adds these.'}
          </p>
        ) : (
          <div className="adm-tablewrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Objective</th>
                  <th>Belongs to</th>
                  <th>In effect</th>
                  <th>Status</th>
                  {canManage ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>{active.map((o) => <ObjectiveRow key={o.id} o={o} />)}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="adm-card">
        <h2 className="adm-card__title">What Loop measures</h2>
        <p className="adm-faint">
          An objective is written in your words. Before Loop can measure one, a
          person has to say what to measure and which of the campaigns, sources,
          buyers and vendors Loop has already seen belong to it. Loop does not
          guess this, does not read it out of the wording, and does not infer a
          category or a place from a provider&rsquo;s labels.
        </p>
        <p className="adm-faint">
          There is no target and no baseline here on purpose. Loop measures what{' '}
          <em>changed</em>; whether a number was good enough is a judgement it has
          no standing to make.
        </p>

        {active.length === 0 ? (
          <p className="adm-faint">Add an objective first.</p>
        ) : (
          <div className="adm-tablewrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Objective</th>
                  <th>What Loop measures</th>
                  <th>Over which population</th>
                  {canManage ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {active.map((o) => {
                  const binding = bindingByObjective.get(o.id) ?? null;
                  return (
                    <tr key={o.id}>
                      <td><strong>{o.title}</strong></td>
                      <td>
                        {binding ? (
                          <>
                            {MEASURE_METRIC_DEFINITIONS[binding.metric].label}
                            <div className="adm-faint">
                              {MEASURE_DIRECTION_LABELS[binding.direction]} · version {binding.version}
                              {binding.confirmedByName ? ` · confirmed by ${binding.confirmedByName}` : ''}{' '}
                              {fmtDate(binding.confirmedAt)}
                            </div>
                            <div className="adm-faint">
                              {MEASURE_METRIC_DEFINITIONS[binding.metric].formula}
                            </div>
                          </>
                        ) : (
                          // An honest first-class state. Not an error, not a
                          // warning, and never filled with a default: an
                          // objective may legitimately exceed what Loop can
                          // measure, and saying so is better than inventing a
                          // proxy metric.
                          <>
                            <span className="adm-badge">Not measurable yet</span>
                            <div className="adm-faint">
                              Loop has no measure for this objective, so it will
                              not produce headlines for it. That may be the right
                              answer — some objectives have no honest metric in
                              the data Loop holds.
                            </div>
                          </>
                        )}
                      </td>
                      <td>
                        {binding ? (
                          <>
                            {describePopulation(binding)}
                            <div className="adm-faint">
                              {binding.members
                                .map((m) => m.labelAtConfirmation ?? m.externalId)
                                .join(', ')}
                            </div>
                          </>
                        ) : (
                          <span className="adm-faint">—</span>
                        )}
                      </td>
                      {canManage ? (
                        <td>
                          <details className="adm-inline">
                            <summary className="adm-btn">
                              {binding ? 'Change what Loop measures' : 'Choose what Loop measures'}
                            </summary>
                            <form action={confirmMeasureBindingAction} className="adm-inviteform">
                              <input type="hidden" name="objectiveId" value={o.id} />

                              <label className="adm-field">
                                <span className="adm-field__label">What should Loop measure?</span>
                                <select
                                  className="adm-input"
                                  name="metric"
                                  defaultValue={binding?.metric ?? 'CALL_VOLUME'}
                                >
                                  {MEASURE_METRICS.map((m) => (
                                    <option key={m} value={m}>
                                      {MEASURE_METRIC_DEFINITIONS[m].label}
                                    </option>
                                  ))}
                                </select>
                              </label>

                              <label className="adm-field">
                                <span className="adm-field__label">Which direction is the good one?</span>
                                <select
                                  className="adm-input"
                                  name="direction"
                                  defaultValue={binding?.direction ?? 'HIGHER_IS_BETTER'}
                                >
                                  {MEASURE_DIRECTIONS.map((d) => (
                                    <option key={d} value={d}>
                                      {MEASURE_DIRECTION_LABELS[d]}
                                    </option>
                                  ))}
                                </select>
                              </label>

                              <fieldset className="adm-field">
                                <legend className="adm-field__label">
                                  Which of these belong to this objective?
                                </legend>
                                {candidates.length === 0 ? (
                                  <p className="adm-faint">
                                    Loop has not observed any campaign, source, buyer
                                    or vendor with a stable identifier in the last{' '}
                                    {CANDIDATE_WINDOW_DAYS} days. Until it has, this
                                    objective cannot be measured — and Loop will say
                                    so rather than measure something else.
                                  </p>
                                ) : (
                                  <>
                                    <p className="adm-faint">
                                      Everything Loop has actually seen, with how many
                                      calls carried it. Items the provider labelled but
                                      never gave an identifier are not listed: a
                                      population keyed on a label changes the day
                                      somebody renames a campaign.
                                    </p>
                                    {candidates.map((c) => {
                                      const value = `${c.dimension}:${c.externalId}`;
                                      const checked = binding?.members.some(
                                        (m) => m.dimension === c.dimension && m.externalId === c.externalId,
                                      );
                                      return (
                                        <label key={value} className="adm-check">
                                          <input
                                            type="checkbox"
                                            name="member"
                                            value={value}
                                            defaultChecked={checked}
                                          />{' '}
                                          <span>
                                            {c.label ?? c.externalId}{' '}
                                            <span className="adm-faint">
                                              {BINDING_DIMENSION_LABELS[c.dimension]} ·{' '}
                                              {c.observedCalls.toLocaleString('en-US')} call
                                              {c.observedCalls === 1 ? '' : 's'}
                                            </span>
                                          </span>
                                          {/* Display label, carried so the binding
                                              records what it was called when it was
                                              confirmed. Never identity. */}
                                          <input
                                            type="hidden"
                                            name={`label:${value}`}
                                            value={c.label ?? ''}
                                          />
                                        </label>
                                      );
                                    })}
                                  </>
                                )}
                              </fieldset>

                              <label className="adm-field">
                                <span className="adm-field__label">
                                  Only count callers in these states (optional)
                                </span>
                                <input
                                  className="adm-input"
                                  name="callerState"
                                  defaultValue={binding?.callerStates.join(', ') ?? ''}
                                  placeholder="Leave empty for no restriction"
                                />
                                <span className="adm-faint">
                                  Leave this empty unless you specifically mean where
                                  the <em>caller</em> was. Which business a campaign
                                  belongs to and where its callers happen to live are
                                  different facts, and the selection above is the one
                                  that defines the business.
                                </span>
                              </label>

                              <button className="adm-btn adm-btn--primary" type="submit">
                                Confirm what Loop measures
                              </button>
                              <span className="adm-faint">
                                {' '}Confirming records a new version. The previous one
                                is kept, so headlines already produced keep their
                                original meaning.
                              </span>
                            </form>
                          </details>
                          {binding ? (
                            <form action={retireMeasureBindingAction} className="adm-inline">
                              <input type="hidden" name="bindingId" value={binding.id} />
                              <button className="adm-btn" type="submit">Stop measuring</button>
                            </form>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="adm-card">
        <h2 className="adm-card__title">Headlines</h2>
        <p className="adm-faint">
          Measured developments in an objective&rsquo;s world: something changed,
          by this much, against this comparison. A headline is <em>not</em> a
          decision and nothing here is asking to be actioned — it records what Loop
          measured, so a person can decide whether it matters.
        </p>
        <p className="adm-faint">
          Every headline compares the last {COMPARISON_SPAN_DAYS} complete days
          against the {COMPARISON_SPAN_DAYS} before them. A day still in progress is
          never compared against a whole one.
        </p>

        {!observation.fullyObserved ? (
          // NOT MEASURABLE — INCOMPLETE DATA.
          //
          // Said in the operator's language, not the engine's: the question is
          // whether these days can be compared, and the answer is no, because some
          // of them were never seen. The dates are listed because they are what
          // somebody would act on. Nothing here mentions ledgers, pagination or
          // certification — that vocabulary belongs to Diagnostics.
          <p className="adm-faint recon-verdict recon-verdict--crit">
            <strong>{NOT_MEASURABLE_INCOMPLETE_DATA}</strong>{' '}
            Loop has call activity for {observation.observedDayCount} of the{' '}
            {observation.dates.length} days in this comparison. Measuring across the
            rest would report missing days as a fall in activity, so nothing is
            measured until they are accounted for.{' '}
            {observation.uncertified.length <= 8 ? (
              <>Not accounted for: {observation.uncertified.map((u) => u.businessDate).join(', ')}.</>
            ) : (
              <>
                Not accounted for: {observation.uncertified.slice(0, 8).map((u) => u.businessDate).join(', ')}{' '}
                and {observation.uncertified.length - 8} more.
              </>
            )}
          </p>
        ) : null}

        {canManage ? (
          <form action={detectHeadlinesAction} className="adm-inline">
            <button className="adm-btn" type="submit">Measure now</button>
            <span className="adm-faint">
              {' '}Runs one deterministic rule over the objectives that have a
              confirmed measure. No model is called, nothing is ranked, and nothing
              is sent anywhere. Running it twice in the same period changes nothing.
              {!observation.fullyObserved
                ? ' While days are unaccounted for it will measure nothing and say so.'
                : ''}
            </span>
          </form>
        ) : null}

        {headlines.length === 0 ? (
          // An honest empty state, and the distinction matters: "nothing crossed a
          // threshold" and "nothing could be measured" are opposite situations and
          // must not look alike.
          <p className="adm-faint">
            No headlines recorded yet.{' '}
            {activeBindings.length === 0
              ? 'No objective has a confirmed measure, so Loop has not measured anything.'
              : !observation.fullyObserved
                // "Nothing crossed a threshold" would be an all-clear, and Loop has
                // not checked. Three sentences apart in the source, opposite
                // meanings on screen.
                ? 'Loop has a measure to work with but has not been able to compare these periods, for the reason above.'
                : 'Loop has a measure to work with; nothing has crossed the threshold, which is a result rather than a gap.'}
          </p>
        ) : (
          <div className="adm-tablewrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>What changed</th>
                  <th>Objective</th>
                  <th>The measurement</th>
                  <th>Why Loop is saying this</th>
                  {canManage ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {headlines.map((h) => (
                  <HeadlineRow key={h.id} h={h} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="adm-card">
        <h2 className="adm-card__title">Commercial signals</h2>
        <p className="adm-faint">
          Observations Loop already recorded that share subject matter with an
          objective above, and the reason each one was considered relevant. A
          signal says an observation <em>may</em> matter to an objective. It is
          not a conclusion, a recommendation, or something asking to be actioned.
        </p>

        {canManage ? (
          <form action={evaluateActivityAction} className="adm-inline">
            <button className="adm-btn" type="submit">
              Evaluate recent activity
            </button>
            <span className="adm-faint">
              {' '}Runs a deterministic term match over the last 30 days of recorded
              calls. No model is called and nothing is sent anywhere.
            </span>
          </form>
        ) : null}

        {signals.length === 0 ? (
          // An honest empty state. Nothing has been evaluated, or nothing
          // matched — and neither is a claim that Loop examined the data and
          // found it irrelevant. No negative determinations are kept.
          <p className="adm-faint">
            No signals recorded yet.
            {canManage
              ? ' Run an evaluation above once at least one objective is active.'
              : ' An administrator runs these.'}
          </p>
        ) : (
          <div className="adm-tablewrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Observed</th>
                  <th>What was observed</th>
                  <th>Objective</th>
                  <th>Why Loop thinks it may matter</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {fmtDate(s.observation.observedAt)}
                      <div className="adm-faint">{s.observation.sourceSystem}</div>
                    </td>
                    {/* The source's own statement, labelled as the source's. */}
                    <td>
                      {s.observation.summary}
                      <div className="adm-faint">
                        Reference {s.observation.sourceReference ?? s.observation.sourceKey}
                      </div>
                    </td>
                    <td>{s.objectiveTitle ?? '—'}</td>
                    {/* Loop's inference, never presented as the source's fact. */}
                    <td>
                      {s.relevance.rationale}
                      <div className="adm-faint">
                        Established {fmtDate(s.firstEvaluatedAt)} by{' '}
                        {s.relevance.evaluatorId} {s.relevance.evaluatorVersion}
                        {s.evaluationCount > 1
                          ? ` · seen again ${s.evaluationCount - 1} time${s.evaluationCount === 2 ? '' : 's'}`
                          : ''}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {totalSignals > signals.length ? (
              <p className="adm-faint">
                Showing the {signals.length} most recent of {totalSignals} recorded.
              </p>
            ) : null}
          </div>
        )}
      </section>

      {archived.length > 0 ? (
        <section className="adm-card">
          <h2 className="adm-card__title">Archived</h2>
          {showArchived ? (
            <div className="adm-tablewrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Objective</th>
                    <th>Belongs to</th>
                    <th>In effect</th>
                    <th>Status</th>
                    {canManage ? <th>Actions</th> : null}
                  </tr>
                </thead>
                <tbody>{archived.map((o) => <ObjectiveRow key={o.id} o={o} />)}</tbody>
              </table>
            </div>
          ) : (
            <p className="adm-faint">
              {archived.length} archived objective{archived.length === 1 ? '' : 's'} kept on record.{' '}
              <a href="/app/admin/administration/objectives?show=archived">Show them</a>
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
