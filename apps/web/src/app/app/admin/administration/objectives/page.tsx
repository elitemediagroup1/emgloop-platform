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
// THIS IS NOT THE COMMERCIAL INTELLIGENCE EXPERIENCE. There is no headline feed,
// no investigation workspace, no signal explorer, no score, no chart and no
// recommendation, because none of those exist yet and a surface that hinted at
// them would be promising something the platform cannot do. When CI has
// something to say, it will say it somewhere else.
//
// THE SIGNALS TABLE IS AN INSPECTION SURFACE, NOT AN ATTENTION SURFACE. It is
// ordered by when the observation happened and by nothing else: no ranking, no
// badge implying confidence, no "needs your attention", no CTA on a row, and
// nothing to click through to. Deciding what deserves a person's attention is a
// later stage with its own vocabulary, and it does not begin here.
//
// Server components only, same as every other administration page: every control
// is a <form> posting to a guarded server action, so authoring costs no client
// JavaScript. Reuses the existing `adm-*` design-system classes — no new CSS.

import { requirePermission, hasPermission } from '../../../../../auth/guard';
import { repositories } from '@emgloop/database';
import {
  PERFORMANCE_OBJECTIVE_SCOPE_LABELS,
  PERFORMANCE_OBJECTIVE_STATUS_LABELS,
  PERFORMANCE_OBJECTIVE_TITLE_MAX,
  type PerformanceObjectiveView,
} from '@emgloop/shared';
import {
  createObjectiveAction,
  updateObjectiveAction,
  setObjectiveStatusAction,
  evaluateActivityAction,
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

export default async function AdminObjectivesPage({
  searchParams,
}: {
  searchParams?: { notice?: string; error?: string; show?: string };
}) {
  const session = await requirePermission('commercialIntelligence', 'view');
  const canManage = await hasPermission('commercialIntelligence', 'update');
  const canCreate = await hasPermission('commercialIntelligence', 'create');

  const objectives = await repositories.performanceObjectives.list(session.organizationId);
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
