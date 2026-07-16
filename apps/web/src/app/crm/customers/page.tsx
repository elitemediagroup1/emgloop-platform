import Link from 'next/link';
import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';
import { crmRepos, requireCrmContext } from '../../../crm/crm-data';
import {
  PIPELINE_STATUSES,
  type PipelineStatus,
  type CustomerSortKey,
} from '@emgloop/database';
import { BulkBar } from './bulk-bar';

// Customers list — Sprint 5 (Phase 1) + Sprint 6 (Phase 2).
//
// A searchable, sortable, filterable, paginated customer table read straight
// from Neon via the repository layer. Sprint 6 adds saved views (sharable
// filter presets) and bulk operations (select rows → set status / add tag /
// assign), wired to server actions through a small client selection bar.

export const dynamic = 'force-dynamic';

type SP = {
  q?: string;
  status?: string;
  tag?: string;
  sort?: string;
  dir?: string;
  page?: string;
};

// Saved views: named, sharable filter presets. Pure URL state — no schema
// change required. Each renders as a one-click chip.
const SAVED_VIEWS: { label: string; sp: Partial<SP> }[] = [
  { label: 'All customers', sp: {} },
  { label: 'New leads', sp: { status: 'New', sort: 'createdAt', dir: 'desc' } },
  { label: 'Hot leads', sp: { tag: 'Hot Lead' } },
  { label: 'Booked', sp: { status: 'Booked' } },
  { label: 'VIPs', sp: { tag: 'VIP' } },
  { label: 'Recently active', sp: { sort: 'lastSeenAt', dir: 'desc' } },
];

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

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

function buildQuery(base: SP, override: Partial<SP>): string {
  const merged = { ...base, ...override };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v) params.set(k, String(v));
  }
  const s = params.toString();
  return s ? '?' + s : '';
}

function viewMatches(sp: SP, view: Partial<SP>): boolean {
  const keys: (keyof SP)[] = ['q', 'status', 'tag', 'sort', 'dir'];
  return keys.every((k) => (sp[k] ?? '') === (view[k] ?? ''));
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const { organizationId } = await requireCrmContext();
  const sp = searchParams ?? {};
  const q = sp.q ?? '';
  const statusFilter = (PIPELINE_STATUSES as string[]).includes(sp.status ?? '')
    ? (sp.status as PipelineStatus)
    : null;
  const tagFilter = sp.tag ?? null;
  const sort = (['createdAt', 'lastSeenAt', 'name', 'status'].includes(
    sp.sort ?? '',
  )
    ? sp.sort
    : 'createdAt') as CustomerSortKey;
  const dir = sp.dir === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);

  const result = await loadOrFallback(async () => {
    if (!organizationId) {
      return {
        empty: true as const,
        list: null,
        tags: [] as string[],
        counts: null,
      };
    }
    const [list, tags, counts] = await Promise.all([
      crmRepos.crm.listCustomers(organizationId, {
        search: q,
        status: statusFilter,
        tag: tagFilter,
        sort,
        direction: dir,
        page,
        pageSize: 25,
      }),
      crmRepos.crm.listTags(organizationId),
      crmRepos.crm.statusCounts(organizationId),
    ]);
    return { empty: false as const, list, tags, counts };
  });

  if (!result.ok) return <DbNotConfigured />;

  if (result.data.empty || !result.data.list) {
    return (
      <>
        <h1 className="crm-h1">Customers</h1>
        <p className="crm-sub">Internal operations console.</p>
        <div className="crm-panel crm-empty" style={{ marginTop: '1rem' }}>
          No customers yet. Customers appear here as they are captured for
          your organization.
        </div>
      </>
    );
  }

  const { list, tags, counts } = result.data;

  const sortLink = (key: CustomerSortKey, label: string) => {
    const isActive = sort === key;
    const nextDir = isActive && dir === 'desc' ? 'asc' : 'desc';
    const arrow = isActive ? (dir === 'desc' ? ' ↓' : ' ↑') : '';
    return (
      <Link href={'/crm/customers' + buildQuery(sp, { sort: key, dir: nextDir, page: '1' })}>
        {label}
        {arrow}
      </Link>
    );
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '1rem' }}>
        <div>
          <h1 className="crm-h1">Customers</h1>
          <p className="crm-sub">
            {list.total} total · page {list.page} of {list.pageCount}
          </p>
        </div>
        <span style={{ marginLeft: 'auto' }}>
          <Link className="crm-btn crm-btn-ghost" href="/crm/pipeline">
            Pipeline board
          </Link>
        </span>
      </div>

      <div className="crm-views">
        {SAVED_VIEWS.map((v) => (
          <Link
            key={v.label}
            className={'crm-view' + (viewMatches(sp, v.sp) ? ' active' : '')}
            href={'/crm/customers' + buildQuery({}, { ...v.sp, page: '1' })}
          >
            {v.label}
          </Link>
        ))}
      </div>

      <form className="crm-toolbar" method="get" action="/crm/customers">
        <input
          className="crm-input crm-search"
          type="text"
          name="q"
          defaultValue={q}
          placeholder="Search name, company, email, phone, address, external ID…"
        />
        <select className="crm-select" name="status" defaultValue={statusFilter ?? ''}>
          <option value="">All statuses</option>
          {PIPELINE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s} ({counts ? counts[s] : 0})
            </option>
          ))}
        </select>
        <select className="crm-select" name="tag" defaultValue={tagFilter ?? ''}>
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="dir" value={dir} />
        <button className="crm-btn" type="submit">
          Apply
        </button>
        <Link className="crm-btn crm-btn-ghost" href="/crm/customers">
          Reset
        </Link>
      </form>

      <div className="crm-chips" style={{ marginBottom: '0.85rem' }}>
        <Link
          className={'crm-chip' + (!statusFilter ? ' active' : '')}
          href={'/crm/customers' + buildQuery(sp, { status: '', page: '1' })}
        >
          All
        </Link>
        {PIPELINE_STATUSES.map((s) => (
          <Link
            key={s}
            className={'crm-chip' + (statusFilter === s ? ' active' : '')}
            href={'/crm/customers' + buildQuery(sp, { status: s, page: '1' })}
          >
            {s} · {counts ? counts[s] : 0}
          </Link>
        ))}
      </div>

      <BulkBar tags={tags} />

      <div className="crm-panel">
        <table className="crm-table crm-table-select">
          <thead>
            <tr>
              <th className="crm-checkcol">
                <input type="checkbox" data-bulk-all aria-label="Select all" />
              </th>
              <th>{sortLink('name', 'Customer')}</th>
              <th>Company</th>
              <th>Phone</th>
              <th>Email</th>
              <th>City / State</th>
              <th>{sortLink('status', 'Status')}</th>
              <th>{sortLink('lastSeenAt', 'Last interaction')}</th>
              <th>Assigned AI</th>
              <th>Assigned human</th>
              <th>{sortLink('createdAt', 'Created')}</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="crm-empty">
                  No customers match these filters.
                </td>
              </tr>
            ) : (
              list.rows.map((c) => (
                <tr key={c.id}>
                  <td className="crm-checkcol">
                    <input
                      type="checkbox"
                      data-bulk-row
                      value={c.id}
                      aria-label={'Select ' + c.name}
                    />
                  </td>
                  <td>
                    <Link href={'/crm/customers/' + c.id} className="crm-cell-name">
                      {c.name}
                    </Link>
                    {c.tags.length > 0 ? (
                      <div style={{ marginTop: '0.25rem' }}>
                        {c.tags.slice(0, 3).map((t) => (
                          <span className="crm-tag" key={t}>
                            {t}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td>{c.company || <span className="crm-faint">—</span>}</td>
                  <td>{c.phone || <span className="crm-faint">—</span>}</td>
                  <td>{c.email || <span className="crm-faint">—</span>}</td>
                  <td>
                    {c.city || c.state ? (
                      <>
                        {c.city}
                        {c.city && c.state ? ', ' : ''}
                        {c.state}
                      </>
                    ) : (
                      <span className="crm-faint">—</span>
                    )}
                  </td>
                  <td>
                    <span className={'crm-status ' + c.status}>{c.status}</span>
                  </td>
                  <td>
                    {relTime(c.lastInteractionAt)}
                    {c.lastInteractionLabel ? (
                      <div className="crm-cell-sub">{c.lastInteractionLabel}</div>
                    ) : null}
                  </td>
                  <td>{c.assignedAI || <span className="crm-faint">—</span>}</td>
                  <td>{c.assignedHuman || <span className="crm-faint">—</span>}</td>
                  <td>{fmtDate(c.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="crm-pagination">
        <span className="crm-muted">
          Showing {list.rows.length} of {list.total}
        </span>
        <span className="pages">
          {list.page > 1 ? (
            <Link
              className="crm-btn crm-btn-ghost"
              href={'/crm/customers' + buildQuery(sp, { page: String(list.page - 1) })}
            >
              ← Prev
            </Link>
          ) : null}
          {list.page < list.pageCount ? (
            <Link
              className="crm-btn crm-btn-ghost"
              href={'/crm/customers' + buildQuery(sp, { page: String(list.page + 1) })}
            >
              Next →
            </Link>
          ) : null}
        </span>
      </div>
    </>
  );
}
