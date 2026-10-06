import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { CrmOpportunityPartyRefV1 } from '@emgloop/shared';
import { requirePermission } from '../../../../../auth/guard';
import { personHref, readContactPoints, readOpportunity, relationshipHref } from '../../../../../crm/crm-slice-data';
import {
  GAP_LABELS,
  OPPORTUNITIES_HREF,
  PRIMARY_CONTACT_WORDING,
  amountText,
  categoryText,
  memberText,
  opportunitiesListHref,
  ownerText,
  partyRefDisplay,
} from '../../../../../crm/opportunity-display';
import { businessDate, governedTerm } from '../../../../../crm/subject-display';
import { EMG_HREFS } from '../../../../../creator/creator-runtime';
import { ContactPointList } from '../../../../../crm/contact-point-list';
import { resolveWorkspaceRole } from '../../../../../workspaces/role-router';
import { getSession } from '../../../../../auth/auth';
import { viewerTime } from '../../../../../time/viewer-time';
import { Facts, LoopPage, PageHead, Panel, ReadFailed, RecordLayout, StateBlock, SummaryStrip } from '../../../_loop-os/record';

export const dynamic = 'force-dynamic';

// One Opportunity, for staff (CRM slice 4): the pursuit as the Opportunity authority records it.
//
// Its creator, every current BRAND and PRIMARY_CONTACT (none picked), its accountable owner (never
// the person who created the row), category and stage as recorded, the human-authored forecast,
// its stage history, its Participant history exactly as kept (ACTIVE, ENDED, VOIDED -- nothing
// rewritten), the Relationship it sits under, its campaigns, and what EMG designated the creator
// may see. A PRIMARY_CONTACT is the contact for this Opportunity; it says nothing about who they
// work for.
//
// CONTACT POINTS come from their own authority, per contact, on the server: EMPLOYEE and above see
// values, READ_ONLY sees kind, classification and state. Nothing here masks or reveals a value
// itself.
//
// NOTES: only THAT an internal note or a transition note was recorded, never its text, for anyone.
// There is no governed Opportunity-note authority yet, and no other domain's grant stands in for one.
//
// Read-only. Changing owners, participants and stages stays with the governed acts.

export default async function OpportunityPage({ params }: { params: { opportunityId: string } }) {
  await requirePermission('opportunities', 'view');
  const read = await readOpportunity(params.opportunityId);
  const trail = [{ label: 'CRM' }, { label: 'Opportunities', href: OPPORTUNITIES_HREF }];
  if (read === null || read.outcome === 'INVALID_CURSOR') {
    return (
      <LoopPage label="Opportunity">
        <PageHead trail={[...trail, { label: 'Opportunity' }]} title="Opportunity" />
        <ReadFailed what="this opportunity" />
      </LoopPage>
    );
  }
  if (read.outcome === 'NOT_FOUND') notFound();
  if (read.outcome === 'NOT_AUTHORIZED') {
    return (
      <LoopPage label="Opportunity">
        <PageHead trail={[...trail, { label: 'Opportunity' }]} title="Opportunity" />
        <StateBlock kind="denied" title="You cannot view opportunities in this workspace." body="Ask a workspace administrator if you need it." />
      </LoopPage>
    );
  }

  const record = read.value;
  const time = viewerTime();
  // The Creator Hub record is an admin-workspace page that guards itself; it is offered only to
  // the workspace that can open it.
  const session = await getSession();
  const adminWorkspace = session ? resolveWorkspaceRole(session) === 'ADMIN' : false;
  const contactPoints = new Map(
    await Promise.all(
      record.primaryContacts
        .filter((c) => c.state !== 'UNAVAILABLE')
        .map(async (c) => [c.partyId, await readContactPoints(c.state === 'SUPERSEDED' ? c.canonicalPartyId : c.partyId)] as const),
    ),
  );
  const creator = partyRefDisplay(record.creator);
  const forecastAmount = amountText(record.forecast.amountMinor, record.forecast.currency);

  return (
    <LoopPage label={record.title}>
      <PageHead
        trail={[...trail, { label: record.title }]}
        title={record.title}
        subtitle={`${creator.text} · ${record.stage} · ${categoryText(record.category)}`}
      />

      {record.gaps.length > 0 ? (
        <StateBlock
          kind="attention"
          compact
          title={`Missing: ${record.gaps.map((g) => GAP_LABELS[g].replace(/^No /, '').toLowerCase()).join(', ')}.`}
          body="These are not recorded on this opportunity. Loop does not fill them in."
        />
      ) : null}

      <SummaryStrip
        label="Summary"
        items={[
          { label: 'Category', value: categoryText(record.category) },
          { label: 'Stage', value: record.stage },
          { label: 'Owner', value: record.owner ? ownerText(record.owner) : null, unknownText: 'Unassigned' },
          { label: 'Updated', value: time.date(record.updatedAt) },
        ]}
      />

      <RecordLayout
        railLabel="Accountability and context"
        main={
          <>
            <Panel title="Who it involves">
              <Facts
                rows={[
                  { label: 'Creator', value: <PartyLine reference={record.creator} /> },
                  {
                    label: record.brands.length > 1 ? `Brands (${record.brands.length})` : 'Brand',
                    value: record.brands.length ? <PartyList refs={record.brands} /> : null,
                    unknownText: 'No brand recorded',
                  },
                  {
                    label: record.primaryContacts.length > 1 ? `Primary contacts (${record.primaryContacts.length})` : 'Primary contact',
                    value: record.primaryContacts.length ? <PartyList refs={record.primaryContacts} /> : null,
                    unknownText: 'No primary contact recorded',
                  },
                ]}
              />
              <p className="loop-note" style={{ marginTop: 10 }}>
                {PRIMARY_CONTACT_WORDING}: the person to talk to about this pursuit. It does not record who they work for.
              </p>
            </Panel>

            <Panel title="Forecast and outcome" lead="Entered by people. Loop does not calculate these.">
              <Facts
                rows={[
                  { label: 'Probability', value: record.forecast.probability === null ? null : `${record.forecast.probability}%`, unknownText: 'Not forecast' },
                  { label: 'Amount', value: forecastAmount, unknownText: 'Not recorded' },
                  { label: 'Expected close', value: record.forecast.expectedCloseDate ? businessDate(record.forecast.expectedCloseDate) : null, unknownText: 'Not recorded' },
                  {
                    label: 'Forecast by',
                    value: record.forecast.authoredBy
                      ? `${memberText(record.forecast.authoredBy)}${record.forecast.authoredAt ? `, ${time.date(record.forecast.authoredAt)}` : ''}`
                      : null,
                    unknownText: 'Not recorded',
                  },
                  { label: 'Outcome', value: record.outcome, unknownText: record.category === 'OPEN' ? 'Still open' : 'Not recorded' },
                  ...(record.lossReason ? [{ label: 'Loss reason', value: record.lossReason }] : []),
                ]}
              />
            </Panel>

            <section id="history" aria-label="Stage history">
              <Panel title="Stage history">
                {record.transitions.length === 0 ? (
                  <StateBlock kind="empty" compact title="No stage changes recorded." body="Stage and category changes appear here as they are recorded." />
                ) : (
                  <ol className="loop-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {record.transitions.map((t) => (
                      <li key={t.sequence}>
                        <p className="loop-table__strong">
                          {t.fromStage === null ? `Opened at ${t.toStage}` : `${t.fromStage} → ${t.toStage}`}
                          {t.fromCategory !== null && t.fromCategory !== t.toCategory ? ` · ${categoryText(t.toCategory)}` : ''}
                        </p>
                        <p className="loop-note">
                          <time dateTime={t.occurredAt}>{time.dateTime(t.occurredAt)}</time> · {memberText(t.actor, 'Actor not recorded')}
                          {t.creatorVisible ? ' · shown to the creator' : ''}
                        </p>
                        {t.noteRecorded ? <p className="loop-note">Transition note recorded</p> : null}
                      </li>
                    ))}
                  </ol>
                )}
              </Panel>
            </section>

            <section id="participants" aria-label="Participant history">
              <Panel title="Participant history" lead="Every brand and contact ever recorded on this opportunity, as recorded.">
                {record.participants.length === 0 ? (
                  <p className="loop-note">No brand or contact has been recorded on this opportunity.</p>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table className="loop-table">
                      <caption className="loop-sr-only">Participants, current first</caption>
                      <thead>
                        <tr>
                          <th scope="col">Party</th>
                          <th scope="col">Role</th>
                          <th scope="col">State</th>
                          <th scope="col">Added</th>
                          <th scope="col">Closed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {record.participants.map((p) => (
                          <tr key={p.participantId}>
                            <td>
                              <PartyLine reference={p.party} />
                            </td>
                            <td data-label="Role">{p.role === 'PRIMARY_CONTACT' ? 'Primary contact' : governedTerm(p.role)}</td>
                            <td data-label="State">{governedTerm(p.state)}</td>
                            <td data-label="Added">
                              {time.date(p.addedAt)}
                              <span className="loop-table__muted" style={{ display: 'block' }}>
                                {memberText(p.addedBy, 'By an unrecorded actor')}
                              </span>
                            </td>
                            <td data-label="Closed">
                              {p.endedAt ? `Ended ${time.date(p.endedAt)}` : p.voidedAt ? `Voided ${time.date(p.voidedAt)}` : '—'}
                              {p.reasonRecorded ? (
                                <span className="loop-table__muted" style={{ display: 'block' }}>
                                  Reason recorded
                                </span>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </section>

            <Panel title="Internal notes">
              <p className="loop-note">{record.notes.state === 'RECORDED' ? 'Internal note recorded' : 'No internal note recorded'}</p>
              <p className="loop-note" style={{ marginTop: 10 }}>
                Note text is not shown here: no governed authority for Opportunity notes exists yet.
              </p>
            </Panel>
          </>
        }
        rail={
          <>
            <Panel title="Accountability">
              <Facts
                rows={[
                  { label: 'Owner', value: record.owner ? ownerText(record.owner) : null, unknownText: 'Unassigned' },
                  { label: 'Recorded by', value: memberText(record.createdBy) },
                  { label: 'Recorded', value: time.date(record.createdAt) },
                  { label: 'Updated', value: time.date(record.updatedAt) },
                ]}
              />
              <p className="loop-note" style={{ marginTop: 10 }}>
                The owner is accountable for this pursuit. Everyone who can see opportunities sees it.
              </p>
            </Panel>

            <Panel title="Primary contact details" lead="From each contact's own record.">
              {record.primaryContacts.length === 0 ? (
                <p className="loop-note">No primary contact is recorded, so there are no contact details to show.</p>
              ) : (
                <div className="loop-stack">
                  {record.primaryContacts.map((c) => {
                    const display = partyRefDisplay(c);
                    const points = contactPoints.get(c.partyId);
                    return (
                      <div key={c.partyId}>
                        <p className="loop-table__strong">{display.text}</p>
                        {points === undefined ? (
                          <p className="loop-note">This contact&apos;s record cannot be followed, so no details are shown.</p>
                        ) : (
                          <ContactPointList read={points} time={time} none="No contact point is recorded for this person." />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>

            <Panel title="Linked">
              <Facts
                rows={[
                  {
                    label: 'Relationship',
                    value: record.relationship ? <Link href={relationshipHref(record.relationship.relationshipId)}>{governedTerm(record.relationship.kind)}</Link> : null,
                    unknownText: 'Not linked',
                  },
                  {
                    label: 'Campaigns',
                    value: record.campaigns.length ? record.campaigns.map((c) => `${c.name} (${governedTerm(c.state)})`).join(', ') : null,
                    unknownText: 'None yet',
                  },
                  {
                    label: 'Creator',
                    value: (
                      <>
                        <Link href={opportunitiesListHref({ creator: record.creator.partyId })}>All of this creator&apos;s opportunities</Link>
                        {record.creatorProfileId && adminWorkspace ? (
                          <>
                            {' · '}
                            <Link href={EMG_HREFS.creator(record.creatorProfileId)}>Creator Hub</Link>
                          </>
                        ) : null}
                      </>
                    ),
                  },
                ]}
              />
            </Panel>

            <Panel title="What the creator sees" lead="Designated by EMG. Shown here as it stands.">
              <Facts
                rows={[
                  { label: 'Shown as', value: record.creatorDesignation.creatorVisibleState ? governedTerm(record.creatorDesignation.creatorVisibleState) : null, unknownText: 'Not shown to the creator' },
                  { label: 'Brand shown', value: record.creatorDesignation.brandVisibleToCreator ? 'Yes' : 'No' },
                  { label: 'Summary', value: record.creatorDesignation.summaryForCreator, unknownText: 'None written' },
                ]}
              />
            </Panel>
          </>
        }
      />
    </LoopPage>
  );
}

function PartyLine({ reference }: { reference: CrmOpportunityPartyRefV1 }) {
  const display = partyRefDisplay(reference);
  const isPerson = reference.state !== 'UNAVAILABLE' && reference.partyType === 'PERSON';
  return (
    <span>
      {isPerson && display.openPartyId && display.named ? <Link href={personHref(display.openPartyId)}>{display.text}</Link> : display.text}
      {display.note ? <span className="loop-table__muted" style={{ display: 'block' }}>{display.note}</span> : null}
    </span>
  );
}

function PartyList({ refs }: { refs: readonly CrmOpportunityPartyRefV1[] }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {refs.map((r) => (
        <li key={r.partyId}>
          <PartyLine reference={r} />
        </li>
      ))}
    </ul>
  );
}
