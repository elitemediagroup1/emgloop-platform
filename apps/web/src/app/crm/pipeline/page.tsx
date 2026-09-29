import Link from 'next/link';
import { loadOrFallback, DataUnavailable } from '../../../demo/db-health';
import { crmRepos, requireCrmContext } from '../../../crm/crm-data';
import { requirePermission } from '../../../auth/guard';
import { PIPELINE_STATUSES } from '@emgloop/database';
import { movePipelineAction } from '../../../crm/actions';
import { viewerTime } from '../../../time/viewer-time';
import { OrganizationReadingSection } from '../../../intelligence/domain-reading-section';

// Intake Board — customer intake statuses (Customer.attributes.pipelineStatus),
// not the canonical Opportunity pipeline.
//
// ONLY INTAKE. crm.kanbanBoard() reads intake eligibility: a record is on the board
// when it arrived as a verified website lead or a person has worked it (a CRM note,
// a status change, a Party link). A Customer row is not intake work, so the records
// nobody has worked -- most created by the retired automatic call ingestion -- are
// never columns here; they are counted apart, unchanged, and linked to the records
// list. Each column's count is exact; its cards are the most recently WORKED
// records. Moving a card is a person's status change: attributed and audited.
// No client JS or drag library.

export const dynamic = 'force-dynamic';

const COLUMN_LABEL: Record<string, string> = { UNSET: 'Status not set' };

const COLUMN_ACCENT: Record<string, string> = {
  New: 'var(--crm-blue)',
  Contacted: 'var(--crm-purple)',
  Quoted: 'var(--crm-amber)',
  Booked: 'var(--crm-accent)',
  Completed: 'var(--crm-green)',
  Archived: 'var(--crm-faint)',
};

function relTime(iso: string | null): string {
  return (iso && viewerTime().relative(iso)) || 'No activity';
}

export default async function PipelinePage() {
  // AUTHORIZATION BEFORE THE READ. The resource has existed in the matrix
  // since Sprint 7; this page simply never consulted it, so every signed-in
  // member of the organization saw the whole customer book.
  await requirePermission('pipeline', 'view');
  const { organizationId } = await requireCrmContext();

  const result = await loadOrFallback(async () => crmRepos.crm.kanbanBoard(organizationId, new Date()));

  if (!result.ok) return <DataUnavailable />;

  const { columns, notIntake, complete } = result.data;
  const totalPeople = columns.reduce((n, c) => n + c.count, 0);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '1rem' }}>
        <div>
          <h1 className="crm-h1">Intake Board</h1>
          <p className="crm-sub">{totalPeople.toLocaleString('en-US')} {totalPeople === 1 ? 'record' : 'records'} in intake: website leads and records someone has worked. This is customer intake, not the Opportunity pipeline.{complete ? '' : ' Not every record could be read; these counts are a lower bound.'}</p>
        </div>
        <span style={{ marginLeft: 'auto' }}>
          <Link className="crm-btn crm-btn-ghost" href="/crm/customers">
            List view
          </Link>
        </span>
      </div>
      <OrganizationReadingSection domain="PIPELINE" title="Intake reading" />

      {notIntake > 0 ? (
        <div className="crm-panel" style={{ marginTop: '1rem' }}>
          <strong>{notIntake.toLocaleString('en-US')} {notIntake === 1 ? 'record is' : 'records are'} not in intake.</strong>{' '}
          Nobody has worked {notIntake === 1 ? 'it' : 'them'} and {notIntake === 1 ? 'it' : 'they'} did not arrive as a website lead; most were
          created by the retired automatic call ingestion. {notIntake === 1 ? 'It is' : 'They are'} unchanged and not counted as work. A note, a status
          change or a Party link brings a record into intake.{' '}
          <Link href="/crm/customers">Open the records list</Link>
        </div>
      ) : null}

      {totalPeople === 0 ? (
        <div className="crm-panel crm-empty" style={{ marginTop: '1rem' }}>
          No records in intake yet.
        </div>
      ) : (
        <div className="crm-board">
          {columns.map((col) => (
            <section className="crm-col" key={col.status}>
              <header className="crm-col-head">
                <span
                  className="crm-col-dot"
                  style={{ background: COLUMN_ACCENT[col.status] ?? 'var(--crm-faint)' }}
                />
                <span className="crm-col-name">{COLUMN_LABEL[col.status] ?? col.status}</span>
                <span className="crm-col-count">{col.count.toLocaleString('en-US')}</span>
              </header>
              {col.cards.length < col.count ? (
                <p className="crm-faint crm-col-empty">
                  Showing the {col.cards.length} most recently worked of {col.count.toLocaleString('en-US')}.
                </p>
              ) : null}
              <div className="crm-col-body">
                {col.cards.length === 0 ? (
                  <p className="crm-faint crm-col-empty">Empty</p>
                ) : (
                  col.cards.map((card) => (
                    <article className="crm-kcard" key={card.id}>
                      <Link
                        href={'/crm/customers/' + card.id}
                        className="crm-cell-name"
                      >
                        {card.name}
                      </Link>
                      {card.company ? (
                        <div className="crm-kcard-sub">{card.company}</div>
                      ) : null}
                      <div className="crm-kcard-meta">
                        {card.assignedHuman ? '👤 ' + card.assignedHuman + ' ' : ''}
                        {card.assignedAI ? '🤖 ' + card.assignedAI : ''}
                        {!card.assignedHuman && !card.assignedAI ? 'Unassigned' : ''}
                      </div>
                      <div className="crm-kcard-meta crm-faint">
                        {card.lastWorkedAt ? 'Worked ' + relTime(card.lastWorkedAt) : 'Not worked yet'}
                      </div>
                      <form action={movePipelineAction} className="crm-kcard-move">
                        <input type="hidden" name="customerId" value={card.id} />
                        <select
                          className="crm-select crm-select-sm"
                          name="status"
                          defaultValue={col.status === 'UNSET' ? undefined : col.status}
                        >
                          {PIPELINE_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                        <button className="crm-btn crm-btn-sm" type="submit">
                          Move
                        </button>
                      </form>
                    </article>
                  ))
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
