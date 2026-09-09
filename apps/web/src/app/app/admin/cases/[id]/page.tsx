// The Case Workspace — an investigation already in progress.
//
// ONE READ. `CaseWorkspaceService.case()` composes seven contracts behind one
// organization-scoped gate, and this page renders what it returns. It joins
// nothing, derives nothing and re-reads nothing — a page that assembled those
// itself would have to know which producer owns a `sourceReference` and that an
// unmeasured stage is UNKNOWN rather than fine, and both of those would
// eventually be got wrong in a component.
//
// SECTIONS ARE ORDERED BY WHAT IS CURRENT. The claim and what Loop concludes
// lead; history is last. What Loop could not establish sits at the top, above
// everything, because a Case with a dangling work reference and an unmeasured
// window must not read as a healthy one.
//
// GUARDED AT THE TOP, ORGANIZATION FROM THE SESSION. `commercialIntelligence:view`
// before anything is read. There are no mutations on this page yet, and the
// section below says exactly which controls are missing and why.

import { notFound } from 'next/navigation';
import Link from 'next/link';

import { CASE_STATE_LANGUAGE } from '@emgloop/shared';

import { requirePermission } from '../../../../../auth/guard';
import { NotKnown, ReadError, StateBadge } from '../../../_loop-os/product-state';
import {
  FindingSection,
  FiveWs,
  OutcomeSection,
  ParticipationSection,
  RecommendationsSection,
  TimelineSection,
  WorkSection,
} from '../case-sections';
import { loadCase } from '../case-data';

export const dynamic = 'force-dynamic';

export default async function CaseWorkspacePage({ params }: { params: { id: string } }) {
  const session = await requirePermission('commercialIntelligence', 'view');
  const read = await loadCase(session.organizationId, params.id);

  if (!read.ok) {
    return (
      <div className="cw-page">
        <ReadError what={read.what} retryHref={'/app/admin/cases/' + params.id} />
      </div>
    );
  }
  // Another organization's Case resolves to null in the service and arrives here
  // indistinguishable from one that does not exist.
  const view = read.value;
  if (!view) notFound();

  const brief = view.brief;
  const state = CASE_STATE_LANGUAGE[brief.status];

  return (
    <div className="cw-page">
      <nav className="cw-back">
        <Link href="/app/admin/headlines">← Headlines</Link>
      </nav>

      <header className="cw-head">
        <p className="cw-head__eyebrow">Investigation</p>
        <h1 className="cw-head__title">{brief.title}</h1>

        <div className="cw-head__meta">
          <StateBadge state={brief.status} />
          {state ? <span className="cw-head__what">{state.detail}</span> : null}
        </div>

        {brief.subject ? (
          <p className="cw-head__subject">
            Measured against <strong>{brief.subject}</strong>
          </p>
        ) : null}

        <dl className="cw-head__facts">
          {/* AUTHORIZATION IS A PERSON AND A MOMENT. A Case exists because
              somebody decided it should, and that is the first thing worth
              knowing about it. */}
          <div>
            <dt>Authorized by</dt>
            <dd>
              {brief.authorization
                ? brief.authorization.userId + ' · ' + brief.authorization.at.slice(0, 10)
                : 'Loop has no record of who authorized this.'}
            </dd>
          </div>
          {/* ACCOUNTABILITY AND EXECUTION ARE DIFFERENT QUESTIONS, and neither is
              a "Case owner". Participation carries a third answer again, and the
              section below shows all of it rather than flattening it. */}
          <div>
            <dt>Accountable</dt>
            <dd>{brief.ownerUserId ?? 'Nobody yet'}</dd>
          </div>
          <div>
            <dt>Working it</dt>
            <dd>{brief.assigneeUserId ?? 'Nobody yet'}</dd>
          </div>
          {view.participation && view.participation.awaiting.length > 0 ? (
            <div>
              <dt>Waiting on</dt>
              <dd>
                {view.participation.awaiting.length}{' '}
                {view.participation.awaiting.length === 1 ? 'person' : 'people'}
              </dd>
            </div>
          ) : null}
        </dl>
      </header>

      {/* ABOVE EVERYTHING. A Case whose gaps are buried at the bottom reads as a
          complete one, and this is the section that stops that. */}
      <NotKnown lines={view.notKnown} />

      <FindingSection finding={view.finding} />
      <RecommendationsSection recommendations={view.recommendations} />
      <ParticipationSection participation={view.participation} />
      <WorkSection coordination={view.coordination} />
      <MonitoringSummary view={view} />
      <OutcomeSection outcome={view.outcome} />
      <FiveWs brief={brief} />
      <TimelineSection brief={brief} />

      <section className="cw-sec" aria-labelledby="cw-controls">
        <header className="cw-sec__head">
          <h2 className="cw-sec__title" id="cw-controls">What you can do here</h2>
        </header>
        {/*
          A DISABLED CONTROL WITH A DOCUMENTED GAP BEATS AN INVENTED MUTATION.
          Every governed action listed below exists in the backend and none has a
          route into this page yet; wiring them is the next change, not something
          to fake with a generic updateCase. Saying so on the screen is more
          honest than a page that looks finished.
        */}
        <p className="cw-todo">
          Selecting an option, revising a sequence, accepting or rejecting a finding, changing who
          is involved, revising the monitoring plan and resolving or reopening this investigation
          are all governed actions that exist in the backend. None of them is wired into this
          screen yet, and Loop will not offer a control it cannot honestly perform.
        </p>
      </section>
    </div>
  );
}

/**
 * What is being watched, and what Loop currently concludes about it.
 *
 * INCONCLUSIVE IS NOT SUCCESS, and it is the default today because the
 * measurement seam is unwired. The screen says so rather than dressing an
 * unjudged window as a healthy one.
 */
function MonitoringSummary({ view }: { view: { monitoring: unknown } }) {
  const monitoring = view.monitoring as {
    plan: {
      condition: string;
      baseline: { value: number; unit: string } | null;
      success: { statement: string };
      failure: { statement: string };
      observationStart: string;
      observationEnd: string;
    } | null;
    history: readonly unknown[];
    assessment: { verdict: string; explanation: readonly string[] } | null;
  } | null;

  if (!monitoring?.plan) {
    return (
      <section className="cw-sec" aria-labelledby="cw-mon">
        <header className="cw-sec__head">
          <h2 className="cw-sec__title" id="cw-mon">What Loop is watching</h2>
        </header>
        {/* NOT "monitoring healthy". Nothing is being watched. */}
        <p className="cw-notyet">This investigation is not currently being monitored.</p>
      </section>
    );
  }

  const p = monitoring.plan;
  return (
    <section className="cw-sec" aria-labelledby="cw-mon">
      <header className="cw-sec__head">
        <h2 className="cw-sec__title" id="cw-mon">What Loop is watching</h2>
        <p className="cw-sec__sub">
          What would count as success was written down before the answer was known.
        </p>
      </header>
      <div className="cw-mon">
        <div className="cw-mon__head">
          {monitoring.assessment ? <StateBadge state={monitoring.assessment.verdict} /> : null}
          <span className="cw-mon__cond">{p.condition}</span>
        </div>
        <dl className="cw-mon__plan">
          <div>
            <dt>Baseline</dt>
            {/* NULL IS A REAL ANSWER: a monitor with no baseline can detect a
                threshold breach but cannot report a recovery. */}
            <dd>{p.baseline ? p.baseline.value + ' ' + p.baseline.unit : 'None recorded'}</dd>
          </div>
          <div><dt>Counts as held</dt><dd>{p.success.statement}</dd></div>
          <div><dt>Counts as failed</dt><dd>{p.failure.statement}</dd></div>
          <div>
            <dt>Window</dt>
            <dd>{p.observationStart.slice(0, 10)} → {p.observationEnd.slice(0, 10)}</dd>
          </div>
        </dl>
        {monitoring.assessment ? (
          <ul className="cw-mon__expl">
            {monitoring.assessment.explanation.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {monitoring.history.length > 1 ? (
          <p className="cw-mon__revised">
            The plan has been corrected {monitoring.history.length - 1}{' '}
            {monitoring.history.length === 2 ? 'time' : 'times'}. Every earlier version is kept.
          </p>
        ) : null}
      </div>
    </section>
  );
}
