import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CRM_OPPORTUNITY_CATEGORIES } from '@emgloop/shared';
import { requirePermission } from '../../../../auth/guard';
import { readOpportunities } from '../../../../crm/crm-slice-data';
import {
  GAP_LABELS,
  OPPORTUNITIES_HREF,
  categoryText,
  opportunitiesListHref,
  opportunityHref,
  ownerText,
  parseOpportunityFilters,
  partyRefDisplay,
  partyRefsText,
  type OpportunitySearchParams,
} from '../../../../crm/opportunity-display';
import { viewerTime } from '../../../../time/viewer-time';
import { LoopPage, PageHead, ReadFailed, StateBlock } from '../../_loop-os/record';

export const dynamic = 'force-dynamic';

// Opportunities: every commercial pursuit in this organization, for staff (CRM slice 4).
//
// A projection of the Opportunity authority, never a second one. Each row is the Opportunity as
// recorded: its creator, its current BRAND and PRIMARY_CONTACT Participants (all of them, none
// picked), its accountable owner, its category and its own stage label. Missing facts are said
// plainly ("Unassigned", "No brand recorded"); nothing is inferred to fill them.
//
// PD-F-11 decides who sees this: `opportunities:view` here, and the read service checks the VIEW
// act again. Owning an Opportunity changes nothing about who may see it. Party names follow the
// Party gate. No contact value is read for this list; a record page asks the Contact Point
// authority for its own contacts. Search is discovery over recorded titles, labels and names --
// never contact details, never another workspace.
//
// Read-only. Changing owners, participants and stages stays with the governed acts.

export default async function OpportunitiesPage({ searchParams }: { searchParams?: OpportunitySearchParams }) {
  await requirePermission('opportunities', 'view');
  const parsed = parseOpportunityFilters(searchParams);
  // A contact value typed into search is never searched and does not stay in the address bar.
  if (!parsed.ok) redirect(`${opportunitiesListHref(parsed.params)}${Object.keys(parsed.params).length ? '&' : '?'}refused=contact`);
  const cursor = typeof searchParams?.after === 'string' ? searchParams.after : null;
  const read = await readOpportunities({ cursor, filters: parsed.filters });
  const refusedContactSearch = (searchParams as Record<string, unknown> | undefined)?.refused === 'contact';
  const params = parsed.params;
  const filtered = Object.keys(params).length > 0;
  const time = viewerTime();

  return (
    <LoopPage label="Opportunities">
      <PageHead
        trail={[{ label: 'CRM' }, { label: 'Opportunities', href: OPPORTUNITIES_HREF }]}
        title="Opportunities"
        subtitle="Every brand pursuit in this workspace: who it is for, who it is with, and who is accountable."
      />

      {read === null ? (
        <StateBlock
          kind="unavailable"
          title="Opportunities are not available here yet."
          body="This workspace's database does not have the Opportunity owner and participant records yet."
        />
      ) : null}
      {read?.outcome === 'NOT_AUTHORIZED' ? (
        <StateBlock
          kind="denied"
          title="You cannot view opportunities in this workspace."
          body="Your membership does not include Opportunities. Ask a workspace administrator if you need it."
        />
      ) : null}
      {read?.outcome === 'INVALID_CURSOR' ? (
        <StateBlock
          kind="attention"
          title="This page of opportunities is no longer available."
          body="The link points past a list that has changed. Start again from the first page."
          action={{ label: 'Show the first page', href: opportunitiesListHref(params) }}
        />
      ) : null}

      {read?.outcome === 'OK' ? (
        <>
          <form className="loop-filters" style={{ alignItems: 'flex-end' }} method="get" action={OPPORTUNITIES_HREF} role="search" aria-label="Find opportunities">
            <label className="loop-field">
              <span className="loop-label">Search</span>
              <input
                className="loop-input"
                type="search"
                name="q"
                defaultValue={params.q ?? ''}
                maxLength={100}
                placeholder={read.value.namesReadable ? 'Title, creator, brand, contact or owner' : 'Title, stage or category'}
                autoComplete="off"
              />
            </label>
            <label className="loop-field">
              <span className="loop-label">Owner</span>
              <select className="loop-select" name="owner" defaultValue={params.owner ?? ''}>
                <option value="">Anyone</option>
                <option value="ME">Me</option>
                <option value="NONE">Unassigned</option>
                {read.value.ownerOptions.map((o) => (
                  <option key={o.userId} value={o.userId}>
                    {ownerText(o)}
                  </option>
                ))}
              </select>
            </label>
            <label className="loop-field">
              <span className="loop-label">Category</span>
              <select className="loop-select" name="category" defaultValue={params.category ?? ''}>
                <option value="">Any</option>
                {CRM_OPPORTUNITY_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {categoryText(c)}
                  </option>
                ))}
              </select>
            </label>
            <label className="loop-field">
              <span className="loop-label">Stage</span>
              <select className="loop-select" name="stage" defaultValue={params.stage ?? ''}>
                <option value="">Any</option>
                {read.value.stageOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="loop-field">
              <span className="loop-label">Brand</span>
              <select className="loop-select" name="brand" defaultValue={params.brand ?? ''}>
                <option value="">Any</option>
                <option value="PRESENT">Has a brand</option>
                <option value="MISSING">No brand recorded</option>
              </select>
            </label>
            <label className="loop-field">
              <span className="loop-label">Primary contact</span>
              <select className="loop-select" name="contact" defaultValue={params.contact ?? ''}>
                <option value="">Any</option>
                <option value="PRESENT">Has a primary contact</option>
                <option value="MISSING">No primary contact</option>
              </select>
            </label>
            {params.creator ? <input type="hidden" name="creator" value={params.creator} /> : null}
            <button className="loop-btn loop-btn--primary" type="submit">
              Apply
            </button>
            {filtered ? (
              <Link className="loop-btn loop-btn--quiet" href={OPPORTUNITIES_HREF}>
                Clear
              </Link>
            ) : null}
          </form>

          {refusedContactSearch ? (
            <StateBlock
              kind="attention"
              compact
              title="Contact details are not searchable."
              body="Search finds opportunities by title, stage, category and recorded names. An email address or phone number is never searched."
            />
          ) : null}
          {params.creator ? (
            <p className="loop-note">
              Showing one creator&apos;s opportunities. <Link href={opportunitiesListHref({ ...params, creator: undefined })}>Show every creator</Link>
            </p>
          ) : null}
          {!read.value.namesReadable ? (
            <StateBlock
              kind="attention"
              compact
              title="Names are hidden from you."
              body="You can see opportunities but not the people and companies in them, so each is described only by its type, and search does not look at names."
            />
          ) : null}

          {read.value.items.length === 0 ? (
            <StateBlock
              kind="empty"
              title={cursor ? 'No more opportunities.' : filtered ? 'No opportunities match.' : 'No opportunities recorded yet.'}
              body={
                cursor
                  ? 'This is past the end of the list.'
                  : filtered
                    ? 'Nothing recorded in this workspace matches these filters.'
                    : 'An opportunity appears here once someone records a brand pursuit for a creator.'
              }
              action={cursor || filtered ? { label: filtered ? 'Clear filters' : 'Show the first page', href: cursor ? opportunitiesListHref(params) : OPPORTUNITIES_HREF } : undefined}
            />
          ) : (
            <>
              <p className="loop-resultcount">
                {!cursor && read.value.nextCursor === null
                  ? `${read.value.items.length} ${read.value.items.length === 1 ? 'opportunity' : 'opportunities'}`
                  : `Showing ${read.value.items.length} opportunities, newest first`}
              </p>
              <div style={{ overflowX: 'auto' }}>
                <table className="loop-table">
                  <caption className="loop-sr-only">Opportunities in this workspace, newest first</caption>
                  <thead>
                    <tr>
                      <th scope="col">Opportunity</th>
                      <th scope="col">Creator</th>
                      <th scope="col">Brand</th>
                      <th scope="col">Primary contact</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Stage</th>
                      <th scope="col">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {read.value.items.map((item) => {
                      const creator = partyRefDisplay(item.creator);
                      return (
                        <tr key={item.opportunityId}>
                          <td>
                            <Link className="loop-table__strong" href={opportunityHref(item.opportunityId)}>
                              {item.title}
                            </Link>
                            {item.gaps.length > 0 ? (
                              <span className="loop-table__muted" style={{ display: 'block' }}>
                                {item.gaps.map((g) => GAP_LABELS[g]).join(' · ')}
                              </span>
                            ) : null}
                          </td>
                          <td data-label="Creator">
                            {creator.named ? creator.text : <span className="loop-table__muted">{creator.text}</span>}
                          </td>
                          <td data-label="Brand">
                            {item.brands.length ? partyRefsText(item.brands, '') : <span className="loop-table__muted">No brand recorded</span>}
                          </td>
                          <td data-label="Primary contact">
                            {item.primaryContacts.length ? (
                              partyRefsText(item.primaryContacts, '')
                            ) : (
                              <span className="loop-table__muted">No primary contact</span>
                            )}
                          </td>
                          <td data-label="Owner">
                            {item.owner ? ownerText(item.owner) : <span className="loop-table__muted">Unassigned</span>}
                          </td>
                          <td data-label="Stage">
                            {item.stage}
                            <span className="loop-table__muted" style={{ display: 'block' }}>
                              {categoryText(item.category)}
                            </span>
                          </td>
                          <td data-label="Updated">
                            <time dateTime={item.updatedAt}>{time.date(item.updatedAt)}</time>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {read.value.nextCursor || cursor ? (
                <nav className="loop-pager" aria-label="More opportunities">
                  {cursor ? (
                    <Link className="loop-btn" href={opportunitiesListHref(params)}>
                      First page
                    </Link>
                  ) : (
                    <span />
                  )}
                  {read.value.nextCursor ? (
                    <Link className="loop-btn" href={opportunitiesListHref(params, read.value.nextCursor)}>
                      More opportunities
                    </Link>
                  ) : null}
                </nav>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </LoopPage>
  );
}
