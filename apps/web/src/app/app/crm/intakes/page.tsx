import Link from 'next/link';
import { absentUntilMigrated } from '@emgloop/database';
import {
  INTAKE_STATES,
  INTAKE_STATE_LABELS,
  intakeContent,
  readIntakeTemplate,
  type IntakeState,
} from '@emgloop/shared';
import { hasPermission, requirePermission } from '../../../../auth/guard';
import { qualificationIntakes } from '../../../../intake/intake-runtime';
import { viewerTime } from '../../../../time/viewer-time';
import { LoopPage, PageHead, StateBlock } from '../../_loop-os/record';
export const dynamic = 'force-dynamic';
export default async function IntakeListPage({
  searchParams,
}: {
  searchParams?: { state?: string; party?: string; page?: string };
}) {
  const session = await requirePermission('intakes', 'view');
  await requirePermission('identityResolution', 'view');
  const state = (INTAKE_STATES as readonly string[]).includes(searchParams?.state ?? '')
    ? searchParams!.state
    : undefined;
  const page = Math.max(1, Math.min(100000, parseInt(searchParams?.page ?? '1', 10) || 1));
  const list = await absentUntilMigrated(
    qualificationIntakes().list(session.organizationId, session.userId, {
      state,
      partyId: searchParams?.party,
      page,
    }),
  );
  const canCreate = await hasPermission('intakes', 'create'),
    time = viewerTime();
  const pageHref = (p: number) =>
    `/app/crm/intakes?${new URLSearchParams({ ...(state ? { state } : {}), ...(searchParams?.party ? { party: searchParams.party } : {}), page: String(p) })}`;
  return (
    <LoopPage label="Intake & Qualification">
      <PageHead
        trail={[{ label: 'CRM' }, { label: 'Intake & Qualification' }]}
        title="Intake & Qualification"
        subtitle="What we learned, what needs a decision, and who moves it forward."
        actions={
          canCreate ? (
            <Link className="loop-btn loop-btn--primary" href="/app/crm/intakes/new">
              New intake
            </Link>
          ) : null
        }
      />
      {!list ? (
        <StateBlock
          kind="unavailable"
          title="Intakes are not available yet."
          body="This deployment needs the intake database migration before records can be saved."
        />
      ) : (
        <>
          <form className="loop-filters" method="get">
            <label className="loop-field">
              <span className="loop-label">Review state</span>
              <select className="loop-select" name="state" defaultValue={state ?? ''}>
                <option value="">All states</option>
                {INTAKE_STATES.map((s) => (
                  <option key={s} value={s}>
                    {INTAKE_STATE_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            {searchParams?.party ? (
              <input type="hidden" name="party" value={searchParams.party} />
            ) : null}
            <button className="loop-btn" type="submit">
              Filter
            </button>
            <Link className="loop-btn" href="/app/crm/intakes">
              Clear filters
            </Link>
          </form>
          {list.rows.length ? (
            <div className="iq-list">
              {list.rows.map((record) => {
                const content = intakeContent(record.revisions[0]?.content),
                  template = readIntakeTemplate(record.templateSnapshot);
                return (
                  <Link
                    className="loop-card iq-list-card"
                    href={`/app/crm/intakes/${record.id}`}
                    key={record.id}
                  >
                    <div>
                      <span className="loop-label">
                        {template?.engagement ?? record.templateKey} ·{' '}
                        {template?.label ?? record.subtype}
                      </span>
                      <h2>{content?.title ?? 'Intake record'}</h2>
                      <p>{record.partyName}</p>
                      {content?.nextStep ? <p>{content.nextStep}</p> : null}
                    </div>
                    <div>
                      <span className="loop-pill">
                        {INTAKE_STATE_LABELS[record.state as IntakeState]}
                      </span>
                      <p className="loop-note">Updated {time.relative(record.updatedAt)}</p>
                      <span className="loop-note">Revision {record.currentRevision}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          ) : (
            <StateBlock
              kind="empty"
              title={
                state || searchParams?.party
                  ? 'No intakes match these filters.'
                  : 'Start with your next conversation.'
              }
              body="Choose an existing CRM person or company, then capture the requirements for your engagement."
            />
          )}
          {list.count > 30 ? (
            <nav className="ch-pagination" aria-label="Intake pages">
              {page > 1 ? <Link href={pageHref(page - 1)}>Previous page</Link> : null}
              <span>
                {list.count} intakes · page {page} of {Math.ceil(list.count / 30)}
              </span>
              {page * 30 < list.count ? <Link href={pageHref(page + 1)}>Next page</Link> : null}
            </nav>
          ) : null}
        </>
      )}
    </LoopPage>
  );
}
