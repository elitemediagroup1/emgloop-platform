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

import { hasPermission, requirePermission } from '../../../../../auth/guard';
import { listAssignableUsers } from '../../../employee/work/work-data';
import {
  AddParticipantControl,
  FindingControls,
  LifecycleControls,
  MonitoringControls,
  RecommendationControls,
  ReleaseParticipantControl,
} from '../case-controls';
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

export default async function CaseWorkspacePage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { notice?: string; error?: string };
}) {
  // READ is the broad grant. Every control below requires the narrower AUTHORING
  // grant, checked separately -- and each server action checks it again for
  // itself, because hiding a control is not access control.
  const session = await requirePermission('commercialIntelligence', 'view');
  const canAct = await hasPermission('commercialIntelligence', 'update');
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
  const caseIsOpen = brief.status !== 'RESOLVED' && brief.status !== 'DISMISSED';

  // ONLY LOADED WHEN IT CAN BE USED. A read-only member is never offered the
  // ask-somebody form, so the directory read does not happen for them either.
  const members = canAct ? await listAssignableUsers(session.organizationId) : [];

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

      {searchParams?.notice ? (
        <p className="hl-flash hl-flash--notice" role="status">{searchParams.notice}</p>
      ) : null}
      {searchParams?.error ? (
        <p className="hl-flash hl-flash--error" role="alert">{searchParams.error}</p>
      ) : null}

      {/* ABOVE EVERYTHING. A Case whose gaps are buried at the bottom reads as a
          complete one, and this is the section that stops that. */}
      <NotKnown lines={view.notKnown} />

      <FindingSection
        finding={view.finding}
        controls={
          canAct && view.finding ? (
            <FindingControls
              caseId={params.id}
              findingId={view.finding.findingId}
              state={view.finding.state}
            />
          ) : undefined
        }
      />

      <RecommendationsSection
        recommendations={view.recommendations}
        controls={
          canAct
            ? (optionKey) => {
                const option = view.recommendations?.options.find((o) => o.key === optionKey);
                if (!option) return null;
                return (
                  <RecommendationControls
                    caseId={params.id}
                    optionKey={option.key}
                    // THE MACHINE'S SEQUENCE IS WHAT THE REVISION FORM STARTS
                    // FROM, and the service keeps it whatever the person does.
                    actions={option.actions}
                    selected={option.selectedAt !== null}
                    dismissed={option.dismissed}
                  />
                );
              }
            : undefined
        }
      />

      <ParticipationSection
        participation={view.participation}
        controls={canAct ? <AddParticipantControl caseId={params.id} members={members} /> : undefined}
        releaseControl={
          canAct
            ? (userId, contribution) => (
                <ReleaseParticipantControl
                  caseId={params.id}
                  userId={userId}
                  contribution={contribution}
                />
              )
            : undefined
        }
      />

      <WorkSection coordination={view.coordination} />
      <MonitoringSummary view={view} canAct={canAct} caseId={params.id} />
      <OutcomeSection outcome={view.outcome} />
      <FiveWs brief={brief} />
      <TimelineSection brief={brief} />

      <section className="cw-sec" aria-labelledby="cw-controls">
        <header className="cw-sec__head">
          <h2 className="cw-sec__title" id="cw-controls">Close or reopen</h2>
          <p className="cw-sec__sub">
            Closing records what actually happened, not just that somebody closed it.
          </p>
        </header>
        {canAct ? (
          <LifecycleControls
            caseId={params.id}
            open={caseIsOpen}
            reopenCount={brief.history.timesReopened}
          />
        ) : (
          // EXPLAINED IN TEXT, not silently absent. A person who cannot act
          // should know that is why they see nothing, rather than assuming the
          // product has no such control.
          <p className="cw-todo">
            You can read this investigation. Closing or reopening it needs permission to author
            commercial intelligence.
          </p>
        )}
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
function MonitoringSummary({
  view,
  canAct,
  caseId,
}: {
  view: { monitoring: unknown };
  canAct: boolean;
  caseId: string;
}) {
  const monitoring = view.monitoring as {
    plan: {
      condition: string;
      baseline: { value: number; unit: string } | null;
      success: { statement: string; metric: string; threshold: number };
      failure: { statement: string; threshold: number };
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
        {canAct ? <MonitoringControls caseId={caseId} existing={null} /> : null}
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
        {canAct ? (
          <MonitoringControls
            caseId={caseId}
            // SEEDED FROM WHAT STANDS, so a correction starts from the plan
            // rather than a blank form — and every earlier version survives it.
            existing={{
              condition: p.condition,
              metric: p.success.metric,
              successThreshold: p.success.threshold,
              failureThreshold: p.failure.threshold,
              observationStart: p.observationStart,
              observationEnd: p.observationEnd,
            }}
          />
        ) : null}
      </div>
    </section>
  );
}
