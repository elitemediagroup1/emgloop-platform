import Link from 'next/link';
import { requirePermission } from '../../../../auth/guard';
import { crmSubjectReads, personHref, PEOPLE_HREF } from '../../../../crm/crm-slice-data';
import { readPeopleDirectory } from '../../../../crm/crm-subject-reads';
import { ActionButton, LoopPage, PageHead, ReadFailed, StateBlock, StatePill, type ActionSpec } from '../../_loop-os/record';
import { SubjectCard } from '../../_loop-os/subject-card';
import { OrganizationReadingSection } from '../../../../intelligence/domain-reading-section';

export const dynamic = 'force-dynamic';

// People: established PERSON Parties (handoff 2026-09-16, p. 6; Product C-04).
//
// Intake records never appear here, and an unidentified caller never becomes a
// Person. Records awaiting identity review are not People either: they are counted
// and linked to the governed identity review, which is its own workflow.
//
// Columns are what an authority can answer: the person, their relationship context
// and their identity state. Opportunities have no authority yet, so there is no
// column that would have to show a made-up "0".

const IDENTITY_REVIEW_HREF = '/crm/parties';

export default async function PeoplePage({ searchParams }: { searchParams?: { after?: string | string[] } }) {
  await requirePermission('identityResolution', 'view');
  const cursor = typeof searchParams?.after === 'string' ? searchParams.after : null;
  const directory = await readPeopleDirectory(await crmSubjectReads(), { cursor, personHref });

  const trail = [{ label: 'CRM' }, { label: 'People', href: PEOPLE_HREF }];
  const establish: ActionSpec =
    directory.outcome === 'OK' && directory.capabilities.createParty
      ? { label: '+ Establish person', href: IDENTITY_REVIEW_HREF, primary: true }
      : { label: '+ Establish person', href: null, reason: 'You do not have authority to establish people.' };

  return (
    <LoopPage label="People">
      <PageHead
        trail={trail}
        title="People"
        subtitle="Canonical people established through governed identity workflows."
        actions={directory.outcome === 'OK' ? <ActionButton action={establish} /> : undefined}
      />

      <OrganizationReadingSection domain="CRM" title="People reading" />
      {directory.outcome === 'FAILED' ? <ReadFailed what="people" /> : null}
      {directory.outcome === 'NOT_AUTHORIZED' ? (
        <StateBlock
          kind="denied"
          title="You cannot view people in this workspace."
          body="Your membership does not include canonical identity. Ask a workspace administrator if you need it."
        />
      ) : null}
      {directory.outcome === 'INVALID_CURSOR' ? (
        <StateBlock
          kind="attention"
          title="This page of people is no longer available."
          body="The list changed since the link was made. Start again from the first page."
          action={{ label: 'Show the first page', href: PEOPLE_HREF }}
        />
      ) : null}

      {directory.outcome === 'OK' ? (
        <>
          <div className="loop-filters" role="group" aria-label="People shown">
            <span className="loop-filter" aria-current="true">All people</span>
            {directory.review.state === 'OK' && directory.review.value.count > 0 ? (
              <Link className="loop-filter" href={IDENTITY_REVIEW_HREF}>
                Awaiting identity review · {directory.review.value.count}
                {directory.review.value.more ? '+' : ''}
              </Link>
            ) : null}
          </div>

          {directory.partialContext ? (
            <StateBlock
              kind="attention"
              compact
              title="Relationship context is missing for some people."
              body="Loop could not read their relationships, so that column says so instead of showing nothing."
            />
          ) : null}

          {directory.rows.length === 0 ? (
            directory.firstPage ? (
              <StateBlock
                kind="empty"
                title="No established people yet."
                body="A person appears here once their identity is established through identity review. Intake records and unidentified callers are not people."
                action={
                  directory.review.state === 'OK' && directory.review.value.count > 0
                    ? { label: 'Open identity review', href: IDENTITY_REVIEW_HREF }
                    : undefined
                }
              />
            ) : (
              <StateBlock kind="empty" title="No more people." body="This is past the end of the list." action={{ label: 'Show the first page', href: PEOPLE_HREF }} />
            )
          ) : (
            <>
              <p className="loop-resultcount">
                {directory.firstPage && directory.nextCursor === null
                  ? `${directory.rows.length} ${directory.rows.length === 1 ? 'person' : 'people'}`
                  : `Showing ${directory.rows.length} people`}
              </p>
              <table className="loop-table">
                <caption className="loop-sr-only">Established people and their relationship context</caption>
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">Relationship context</th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {directory.rows.map((row) => (
                    <tr key={row.item.partyId}>
                      <td>
                        <SubjectCard subject={row.subject} density="row" />
                      </td>
                      <td data-label="Relationship context">
                        {row.context.relationship ? (
                          <span className="loop-table__strong">{row.context.relationship}</span>
                        ) : (
                          <span className="loop-table__muted">{row.context.fact.text}</span>
                        )}
                      </td>
                      <td data-label="State">
                        <StatePill state={row.subject.state} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="loop-note">Opportunities are not tracked in Loop yet, so they are not shown for anyone.</p>
              {directory.nextCursor || !directory.firstPage ? (
                <nav className="loop-pager" aria-label="More people">
                  {!directory.firstPage ? (
                    <Link className="loop-btn" href={PEOPLE_HREF}>
                      First page
                    </Link>
                  ) : (
                    <span />
                  )}
                  {directory.nextCursor ? (
                    <Link className="loop-btn" href={`${PEOPLE_HREF}?after=${encodeURIComponent(directory.nextCursor)}`}>
                      More people
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
