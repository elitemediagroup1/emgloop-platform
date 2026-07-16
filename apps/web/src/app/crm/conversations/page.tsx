import Link from 'next/link';
import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';
import { crmRepos, requireCrmContext } from '../../../crm/crm-data';
import { requirePermission } from '../../../auth/guard';
import {
  createSavedViewAction,
  removeSavedViewAction,
} from '../../../crm/conversation-actions';
import type { ConversationStatus } from '@emgloop/database';

// Unified inbox — Sprint 8 (Conversations, Phase 3).
//
// Every open/pending/snoozed/closed conversation across the organization in
// one operator surface, with status / assignee / channel filters, a count
// summary, and per-user saved views promoted from URL presets to real saved
// filters. Each row links to the conversation workspace. Read straight from
// Neon via the conversations repository; the whole page is permission-gated
// behind inbox:view.

export const dynamic = 'force-dynamic';

type SP = {
  status?: string;
  assignee?: string;
  channel?: string;
  q?: string;
};

const STATUSES: ConversationStatus[] = ['OPEN', 'PENDING', 'SNOOZED', 'CLOSED'];

const STATUS_COLOR: Record<string, string> = {
  OPEN: 'var(--crm-accent)',
  PENDING: 'var(--crm-amber)',
  SNOOZED: 'var(--crm-blue)',
  CLOSED: 'var(--crm-faint)',
};

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

function buildQuery(base: SP, patch: Partial<SP>): string {
  const merged = { ...base, ...patch };
  const params = new URLSearchParams();
  if (merged.status) params.set('status', merged.status);
  if (merged.assignee) params.set('assignee', merged.assignee);
  if (merged.channel) params.set('channel', merged.channel);
  if (merged.q) params.set('q', merged.q);
  const s = params.toString();
  return s ? '/crm/conversations?' + s : '/crm/conversations';
}

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const session = await requirePermission('inbox', 'view');

  const statusFilter = (searchParams?.status ?? '').trim().toUpperCase();
  const assigneeFilter = (searchParams?.assignee ?? '').trim();
  const channelFilter = (searchParams?.channel ?? '').trim().toUpperCase();
  const search = (searchParams?.q ?? '').trim();
  const sp: SP = {
    status: statusFilter || undefined,
    assignee: assigneeFilter || undefined,
    channel: channelFilter || undefined,
    q: search || undefined,
  };

  const { organizationId } = await requireCrmContext();

  const result = await loadOrFallback(async () => {
    const [list, assignees, savedViews] = await Promise.all([
      crmRepos.conversationsInbox.listConversations(organizationId, {
        status: (STATUSES as string[]).includes(statusFilter)
          ? (statusFilter as ConversationStatus)
          : null,
        assigneeId: assigneeFilter || null,
        channel: (channelFilter || null) as never,
        search: search || null,
      }),
      crmRepos.crm.listAssignees(organizationId),
      crmRepos.conversationsInbox.listSavedViews(session.userId),
    ]);
    return { empty: false as const, list, assignees, savedViews };
  });

  if (!result.ok) return <DbNotConfigured />;
  if (result.data.empty) {
    return (
      <>
        <h1 className="crm-h1">Inbox</h1>
        <p className="crm-sub">No organization data yet.</p>
      </>
    );
  }

  const { list, assignees, savedViews } = result.data;
  const counts = list.counts;

  return (
    <>
      <h1 className="crm-h1">Conversations</h1>
      <p className="crm-sub">
        The unified inbox — {counts.ALL ?? 0} conversations across the organization.
      </p>

      <div className="crm-chips" style={{ margin: '0.85rem 0' }}>
        <Link
          className={'crm-chip' + (!statusFilter ? ' active' : '')}
          href={buildQuery(sp, { status: undefined })}
        >
          All ({counts.ALL ?? 0})
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            className={'crm-chip' + (statusFilter === s ? ' active' : '')}
            href={buildQuery(sp, { status: s })}
          >
            {s} ({counts[s] ?? 0})
          </Link>
        ))}
      </div>

      <div className="crm-conv-toolbar">
        <form method="get" className="crm-conv-search">
          {statusFilter ? <input type="hidden" name="status" value={statusFilter} /> : null}
          {assigneeFilter ? <input type="hidden" name="assignee" value={assigneeFilter} /> : null}
          {channelFilter ? <input type="hidden" name="channel" value={channelFilter} /> : null}
          <input
            className="crm-input"
            type="search"
            name="q"
            placeholder="Search subject or customer…"
            defaultValue={search}
          />
          <button className="crm-btn-sm" type="submit">Search</button>
        </form>

        <div className="crm-conv-assignees">
          <Link
            className={'crm-chip' + (!assigneeFilter ? ' active' : '')}
            href={buildQuery(sp, { assignee: undefined })}
          >
            Anyone
          </Link>
          {assignees.humans.map((h) => (
            <Link
              key={h.id}
              className={'crm-chip' + (assigneeFilter === h.id ? ' active' : '')}
              href={buildQuery(sp, { assignee: h.id })}
            >
              {h.name}
            </Link>
          ))}
        </div>
      </div>

      <div className="crm-saved-views">
        <span className="crm-faint">Saved views:</span>
        {savedViews.length === 0 ? (
          <span className="crm-faint">none yet</span>
        ) : (
          savedViews.map((v) => (
            <span key={v.id} className="crm-saved-view">
              <Link
                href={buildQuery(
                  {},
                  {
                    status: v.status ?? undefined,
                    assignee: v.assigneeId ?? undefined,
                    channel: v.channel ?? undefined,
                  },
                )}
              >
                {v.name}
              </Link>
              <form action={removeSavedViewAction} style={{ display: 'inline' }}>
                <input type="hidden" name="viewId" value={v.id} />
                <button className="crm-x" type="submit" title="Remove view">×</button>
              </form>
            </span>
          ))
        )}
        <form action={createSavedViewAction} className="crm-save-view-form">
          <input type="hidden" name="status" value={statusFilter} />
          <input type="hidden" name="assigneeId" value={assigneeFilter} />
          <input type="hidden" name="channel" value={channelFilter} />
          <input className="crm-input crm-input-sm" name="name" placeholder="Save current filters as…" />
          <button className="crm-btn-sm" type="submit">Save view</button>
        </form>
      </div>

      <div className="crm-panel">
        {list.rows.length === 0 ? (
          <div className="crm-empty">No conversations match these filters.</div>
        ) : (
          <table className="crm-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Subject</th>
                <th>Channel</th>
                <th>Status</th>
                <th>Assignee</th>
                <th>Last message</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link className="crm-cell-name" href={'/crm/conversations/' + c.id}>
                      {c.customerName}
                    </Link>
                  </td>
                  <td className="crm-cell-muted">{c.subject}</td>
                  <td>{c.channel}</td>
                  <td>
                    <span
                      className="crm-status-pill"
                      style={{ color: STATUS_COLOR[c.status] ?? 'var(--crm-faint)' }}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td>{c.assigneeName}</td>
                  <td className="crm-cell-muted" title={c.lastMessagePreview}>
                    {relTime(c.lastMessageAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
