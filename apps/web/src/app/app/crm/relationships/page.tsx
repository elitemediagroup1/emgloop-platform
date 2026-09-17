import Link from 'next/link';
import { requirePermission } from '../../../../auth/guard';
import { crmSubjectReads, relationshipHref, RELATIONSHIPS_HREF } from '../../../../crm/crm-slice-data';
import { readRelationshipDirectory } from '../../../../crm/crm-subject-reads';
import { ActionButton, LoopPage, PageHead, ReadFailed, StateBlock } from '../../_loop-os/record';
import { SubjectCard } from '../../_loop-os/subject-card';

export const dynamic = 'force-dynamic';

// Relationships: the commercial connections themselves, each a first-class subject
// (handoff 2026-09-16, p. 8). Read from the Relationships authority; a card is the
// Relationship, with its sides named inside it, never two Party cards side by side.
//
// Recording and changing relationships are governed acts that still live on the
// temporary verification screens; this page links there only for people who may act.

export default async function RelationshipsPage({
  searchParams,
}: {
  searchParams?: { after?: string | string[]; voided?: string | string[] };
}) {
  await requirePermission('relationships', 'view');
  const cursor = typeof searchParams?.after === 'string' ? searchParams.after : null;
  const includeVoided = searchParams?.voided === '1';
  const directory = await readRelationshipDirectory(await crmSubjectReads(), { cursor, includeVoided, href: relationshipHref });
  const base = includeVoided ? `${RELATIONSHIPS_HREF}?voided=1` : RELATIONSHIPS_HREF;

  return (
    <LoopPage label="Relationships">
      <PageHead
        trail={[{ label: 'CRM' }, { label: 'Relationships', href: RELATIONSHIPS_HREF }]}
        title="Relationships"
        subtitle="The commercial connections Loop governs, each with its own lifecycle, participants and history."
        actions={
          directory.outcome === 'OK' ? (
            <ActionButton
              action={
                directory.capabilities.create
                  ? { label: '+ Record relationship', href: '/crm/relationships/new', primary: true }
                  : { label: '+ Record relationship', href: null, reason: 'You do not have authority to record relationships.' }
              }
            />
          ) : undefined
        }
      />

      {directory.outcome === 'FAILED' ? <ReadFailed what="relationships" /> : null}
      {directory.outcome === 'NOT_AUTHORIZED' ? (
        <StateBlock
          kind="denied"
          title="You cannot view relationships in this workspace."
          body="Your membership does not include the Relationships area. Ask a workspace administrator if you need it."
        />
      ) : null}
      {directory.outcome === 'INVALID_CURSOR' ? (
        <StateBlock
          kind="attention"
          title="This page of relationships is no longer available."
          body="The list changed since the link was made. Start again from the first page."
          action={{ label: 'Show the first page', href: base }}
        />
      ) : null}

      {directory.outcome === 'OK' ? (
        <>
          <div className="loop-filters" role="group" aria-label="Relationships shown">
            <Link className="loop-filter" href={RELATIONSHIPS_HREF} aria-current={includeVoided ? undefined : 'true'}>
              Current and ended
            </Link>
            <Link className="loop-filter" href={`${RELATIONSHIPS_HREF}?voided=1`} aria-current={includeVoided ? 'true' : undefined}>
              Including voided
            </Link>
          </div>
          {!directory.namesReadable ? (
            <StateBlock
              kind="attention"
              compact
              title="Names are hidden from you."
              body="You can see relationships but not the people and companies in them, so each side is described only by its type."
            />
          ) : null}
          {directory.subjects.length === 0 ? (
            <StateBlock
              kind="empty"
              title={directory.firstPage ? 'No relationships recorded yet.' : 'No more relationships.'}
              body={
                directory.firstPage
                  ? 'A relationship appears here once someone records one between established people or companies.'
                  : 'This is past the end of the list.'
              }
              action={directory.firstPage ? undefined : { label: 'Show the first page', href: base }}
            />
          ) : (
            <div className="loop-cards">
              {directory.subjects.map((subject) => (
                <SubjectCard key={subject.key} subject={subject} density="card" headingLevel="h2" />
              ))}
            </div>
          )}
          {directory.nextCursor ? (
            <nav className="loop-pager" aria-label="More relationships">
              <span />
              <Link
                className="loop-btn"
                href={`${RELATIONSHIPS_HREF}?${includeVoided ? 'voided=1&' : ''}after=${encodeURIComponent(directory.nextCursor)}`}
              >
                More relationships
              </Link>
            </nav>
          ) : null}
        </>
      ) : null}
    </LoopPage>
  );
}
