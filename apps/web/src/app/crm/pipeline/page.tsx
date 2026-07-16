import Link from 'next/link';
import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';
import { crmRepos, requireCrmContext } from '../../../crm/crm-data';
import { PIPELINE_STATUSES } from '@emgloop/database';
import { movePipelineAction } from '../../../crm/actions';

// Pipeline kanban — Sprint 6 (Internal CRM, Phase 2).
//
// Every customer grouped into its pipeline-status column, read from Neon via
// crm.kanbanBoard(). Each card carries a compact status picker that posts the
// movePipelineAction server action to move the customer between columns — no
// client JS or drag library, consistent with the server-rendered CRM. The board
// is the visual counterpart to the Customers list's status filter.

export const dynamic = 'force-dynamic';

const COLUMN_ACCENT: Record<string, string> = {
  New: 'var(--crm-blue)',
  Contacted: 'var(--crm-purple)',
  Quoted: 'var(--crm-amber)',
  Booked: 'var(--crm-accent)',
  Completed: 'var(--crm-green)',
  Archived: 'var(--crm-faint)',
};

function relTime(iso: string | null): string {
  if (!iso) return 'No activity';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

export default async function PipelinePage() {
  const { organizationId } = await requireCrmContext();

  const result = await loadOrFallback(async () => {
    const columns = await crmRepos.crm.kanbanBoard(organizationId);
    return { empty: false as const, columns };
  });

  if (!result.ok) return <DbNotConfigured />;

  const columns = result.data.empty ? [] : result.data.columns;
  const totalCards = columns.reduce((n, c) => n + c.count, 0);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '1rem' }}>
        <div>
          <h1 className="crm-h1">Pipeline</h1>
          <p className="crm-sub">{totalCards} customers across {PIPELINE_STATUSES.length} stages.</p>
        </div>
        <span style={{ marginLeft: 'auto' }}>
          <Link className="crm-btn crm-btn-ghost" href="/crm/customers">
            List view
          </Link>
        </span>
      </div>

      {totalCards === 0 ? (
        <div className="crm-panel crm-empty" style={{ marginTop: '1rem' }}>
          No customers in the pipeline yet. Run an{' '}
          <Link href="/demo/intake" style={{ color: 'var(--crm-accent)' }}>
            intake
          </Link>{' '}
          to populate it.
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
                <span className="crm-col-name">{col.status}</span>
                <span className="crm-col-count">{col.count}</span>
              </header>
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
                        {relTime(card.lastInteractionAt)}
                      </div>
                      <form action={movePipelineAction} className="crm-kcard-move">
                        <input type="hidden" name="customerId" value={card.id} />
                        <select
                          className="crm-select crm-select-sm"
                          name="status"
                          defaultValue={col.status}
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
