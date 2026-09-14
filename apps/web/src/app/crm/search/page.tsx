import Link from 'next/link';
import { crmRepos, requireCrmContext } from '../../../crm/crm-data';
import { requirePermission, hasPermission } from '../../../auth/guard';
import { loadOrFallback } from '../../../demo/db-health';
import { CrmLoadError } from '../../../crm/load-error';

// CRM Governed Search — Phase 1.
//
// Cross-entity search across currently authoritative sources:
// People (Customer intake), Conversations, and Workspace Organization.
// Each source is permission-gated independently. Results are typed
// honestly — a Customer is "Person / Intake Record", never "Opportunity".
//
// Organization-scoped, server-authorized, fail-closed.

export const dynamic = 'force-dynamic';

type ResultKind = 'person' | 'conversation' | 'organization';

interface SearchResult {
  id: string;
  kind: ResultKind;
  title: string;
  subtitle: string;
  href: string;
  meta?: string;
}

function kindLabel(kind: ResultKind): string {
  switch (kind) {
    case 'person': return 'Person / Intake Record';
    case 'conversation': return 'Conversation';
    case 'organization': return 'Workspace Organization';
  }
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const q = (searchParams?.q ?? '').trim();

  await requirePermission('customers', 'view');
  const { organizationId } = await requireCrmContext();

  const canViewConversations = await hasPermission('inbox', 'view');
  const canViewOrganizations = await hasPermission('organizations', 'view');

  // Every repository call runs inside the loader, so a failed read renders the
  // failure state instead of an empty "no results" that would be untrue.
  const loaded = await loadOrFallback(async () => {
    const results: SearchResult[] = [];
    if (!q) return results;
    const searches: Promise<void>[] = [];

    searches.push(
      crmRepos.crm.listCustomers(organizationId, {
        search: q,
        pageSize: 20,
        page: 1,
      }).then((list) => {
        for (const c of list.rows) {
          results.push({
            id: c.id,
            kind: 'person',
            title: c.name || 'Unnamed',
            subtitle: [c.company, c.email, c.phone].filter(Boolean).join(' · ') || 'No contact details',
            href: `/crm/customers/${c.id}`,
            meta: c.status,
          });
        }
      }),
    );

    if (canViewConversations) {
      searches.push(
        crmRepos.conversationsInbox.listConversations(organizationId, {
          search: q,
        }).then((list) => {
          for (const c of list.rows.slice(0, 15)) {
            results.push({
              id: c.id,
              kind: 'conversation',
              title: c.subject || 'No subject',
              subtitle: [c.customerName, c.channel, c.assigneeName].filter(Boolean).join(' · '),
              href: `/crm/conversations/${c.id}`,
              meta: c.status,
            });
          }
        }),
      );
    }

    if (canViewOrganizations) {
      searches.push(
        crmRepos.organizations.findById(organizationId).then((org) => {
          if (org && org.name.toLowerCase().includes(q.toLowerCase())) {
            results.push({
              id: org.id,
              kind: 'organization',
              title: org.name,
              subtitle: [org.industry, org.timezone, org.status].filter(Boolean).join(' · '),
              href: `/crm/organizations/${org.id}`,
              meta: 'Workspace',
            });
          }
        }),
      );
    }

    await Promise.all(searches);
    return results;
  });

  if (!loaded.ok) return <CrmLoadError failure={loaded} surface="Search" />;
  const results = loaded.data;

  const grouped = {
    person: results.filter((r) => r.kind === 'person'),
    conversation: results.filter((r) => r.kind === 'conversation'),
    organization: results.filter((r) => r.kind === 'organization'),
  };
  const totalResults = results.length;

  return (
    <div className="crm-page">
      <div className="crm-page-head">
        <div>
          <h1>Search</h1>
          <p>Search across people, conversations, and your workspace organization.</p>
        </div>
      </div>

      <form className="search-bar" method="get" action="/crm/search" role="search">
        <input
          className="crm-input search-bar__input"
          type="search"
          name="q"
          defaultValue={q}
          autoFocus={!q}
          placeholder="Search by name, email, phone, subject…"
          aria-label="Search the CRM"
        />
        <button className="crm-btn search-bar__btn" type="submit">
          Search
        </button>
      </form>

      {!q ? (
        <div className="search-empty">
          <div className="search-empty__icon" aria-hidden="true">&#128269;</div>
          <p className="search-empty__title">Enter a search query</p>
          <p className="search-empty__desc">
            Search across people (intake records), conversations, and your workspace organization.
            Results are limited to records you have permission to view.
          </p>
        </div>
      ) : totalResults === 0 ? (
        <div className="search-empty">
          <div className="search-empty__icon" aria-hidden="true">&#8709;</div>
          <p className="search-empty__title">No results for &ldquo;{q}&rdquo;</p>
          <p className="search-empty__desc">
            No matching records found across people, conversations, or your workspace organization.
            Try a different query or check spelling.
          </p>
        </div>
      ) : (
        <div className="search-results">
          <p className="search-results__count">
            {totalResults} result{totalResults === 1 ? '' : 's'} for &ldquo;{q}&rdquo;
          </p>

          {(['organization', 'person', 'conversation'] as const).map((kind) => {
            const items = grouped[kind];
            if (items.length === 0) return null;
            return (
              <div key={kind} className="search-group">
                <h2 className="search-group__heading">{kindLabel(kind)}s</h2>
                <ul className="search-group__list" role="list">
                  {items.map((r) => (
                    <li key={r.id}>
                      <Link href={r.href} className="search-result">
                        <span className="search-result__kind">
                          <span className={'search-result__badge search-result__badge--' + r.kind}>
                            {kindLabel(r.kind)}
                          </span>
                        </span>
                        <span className="search-result__body">
                          <span className="search-result__title">{r.title}</span>
                          <span className="search-result__subtitle">{r.subtitle}</span>
                        </span>
                        {r.meta && (
                          <span className="search-result__meta">{r.meta}</span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
