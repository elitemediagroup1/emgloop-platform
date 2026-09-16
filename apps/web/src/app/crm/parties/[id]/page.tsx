// One Party: what makes it canonical identity, what Loop cannot yet say about it,
// which Intake Records point at it, and which Relationships it takes part in.
// OPERATOR TOOLING, TEMPORARY.
//
// THE POSTURE SECTION IS NOT DECORATION. Loop collects no identity evidence yet and
// has no verification, and the record says so in words rather than leaving a reader
// to assume an established Party has been checked against something. C-05 applies:
// none of it is a number.
//
// A LINKED INTAKE RECORD IS CONTEXT, NOT THIS PERSON'S ACTIVITY. The link says an
// operator decided a legacy row refers to this Party. It does not make the calls
// filed against that row into this Party's calls -- 319 of them are attached to a
// record whose phone is not the caller's -- and this page never presents them as such.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { LinkedIntakeRecordRefV1 } from '@emgloop/shared';
import { requirePermission } from '../../../../auth/guard';
import { loadPartyRecord } from '../../../../crm/party-data';
import { loadRelationshipsForParty } from '../../../../crm/relationship-data';
import { viewerTime } from '../../../../time/viewer-time';
import { OperatorNotice } from '../../_operator/OperatorNotice';
import { SideSummary } from '../../_operator/PartyRef';

export const dynamic = 'force-dynamic';

const LIMITATIONS: Record<string, string> = {
  EVIDENCE_NOT_COLLECTED: 'No identity evidence is collected yet. Establishment is a governed decision somebody made, not a verification.',
  VERIFICATION_NOT_AVAILABLE: 'No contact value has a recorded verification. Verification is not built.',
};

export default async function PartyPage({ params }: { params: { id: string } }) {
  await requirePermission('identityResolution', 'view');
  const result = await loadPartyRecord(params.id);
  if (result.outcome !== 'OK') notFound();

  const party = result.value;
  const time = viewerTime();
  const relationships = await loadRelationshipsForParty(params.id);

  return (
    <div className="crm-page">
      <div className="crm-page-head">
        <div>
          <h1>{party.displayName ?? party.partyId}</h1>
          <p className="crm-sub">{party.partyType === 'PERSON' ? 'Person' : 'Company'} · canonical identity</p>
        </div>
        <Link className="crm-link" href="/crm/parties">Back</Link>
      </div>

      <OperatorNotice />

      {party.reference.state === 'SUPERSEDED' ? (
        <p className="crm-panel crm-sub">
          This record has been superseded. It stays readable and nothing pointing at it was rewritten; the
          current record is{' '}
          <Link className="crm-link" href={`/crm/parties/${party.reference.canonicalPartyId}`}>
            {party.reference.canonicalPartyId}
          </Link>. A write naming this id is refused, with that id returned, so a person retries deliberately.
        </p>
      ) : null}
      {party.archived ? (
        <p className="crm-panel crm-sub">
          Archived. It stays readable and keeps every reference it already has, and it takes no new ones.
        </p>
      ) : null}

      <div className="crm-panel">
        <h2 className="crm-h2">Identity posture</h2>
        <dl className="crm-defs">
          <div><dt>Establishment</dt><dd>{party.posture.establishment}</dd></div>
          <div><dt>Basis</dt><dd>{party.posture.basis ?? '—'}</dd></div>
          <div><dt>Established</dt><dd>{party.establishment.establishedAt ? time.monthDayTime(party.establishment.establishedAt) : '—'}</dd></div>
          <div><dt>By</dt><dd>{party.establishment.establishedBy?.displayName ?? '—'}</dd></div>
          <div><dt>Same-Party posture</dt><dd>{party.posture.sameParty}</dd></div>
          <div><dt>Evidence</dt><dd>{party.posture.evidenceTier}</dd></div>
        </dl>
        {party.posture.limitations.length > 0 ? (
          <ul>
            {party.posture.limitations.map((l) => <li key={l} className="crm-sub">{LIMITATIONS[l] ?? l}</li>)}
          </ul>
        ) : null}
      </div>

      <div className="crm-panel">
        <h2 className="crm-h2">Linked Intake Records ({party.linkedIntakeRecords.length})</h2>
        <p className="crm-sub">
          A link records that somebody decided a legacy Intake Record refers to this Party. It does
          <strong> not</strong> make that record&apos;s calls, messages or events this Party&apos;s activity, and
          Loop does not present them that way.
        </p>
        {party.linkedIntakeRecords.length === 0 ? (
          <p className="crm-sub">None. Nothing is linked automatically, and nothing ever will be.</p>
        ) : (
          <table className="crm-table">
            <thead><tr><th>Intake Record</th><th>State</th><th>Basis</th><th>Linked</th><th>By</th></tr></thead>
            <tbody>
              {party.linkedIntakeRecords.map((link: LinkedIntakeRecordRefV1) => (
                <tr key={link.linkId}>
                  <td>{link.customerId}</td>
                  <td>{link.state}{link.reversalReason ? <span className="crm-sub"> · a reason was recorded</span> : null}</td>
                  <td>{link.basis}</td>
                  <td>{time.monthDayTime(link.linkedAt)}</td>
                  <td>{link.linkedBy?.displayName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="crm-panel">
        <h2 className="crm-h2">Relationships</h2>
        {relationships.outcome !== 'OK' ? (
          <p className="crm-sub">You do not have authority to read Relationships.</p>
        ) : relationships.value.items.length === 0 ? (
          <p className="crm-sub">
            This Party takes part in no Relationship yet.{' '}
            <Link className="crm-link" href="/crm/relationships/new">Record one</Link>.
          </p>
        ) : (
          <table className="crm-table">
            <thead><tr><th>Kind</th><th>Between</th><th>State</th></tr></thead>
            <tbody>
              {relationships.value.items.map((item) => (
                <tr key={item.relationshipId}>
                  <td><Link className="crm-link" href={`/crm/relationships/${item.relationshipId}`}>{item.kindLabel}</Link></td>
                  <td><SideSummary sides={item.sides} structure={item.structure} /></td>
                  <td>{item.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
