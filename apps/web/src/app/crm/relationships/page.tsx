// Relationships -- the governed commercial authority. OPERATOR TOOLING, TEMPORARY.
//
// A Relationship is a durable commercial connection somebody ASSERTED: a client, a
// supplier, an agency representing a brand. It is never inferred from traffic, from
// a shared phone number, or from anything a machine noticed.
//
// This page exists so an authorized person can finally use that authority. It is not
// the Relationships experience Charlie and Lexi will design, and it is built to be
// deleted when theirs lands.

import Link from 'next/link';
import { requirePermission } from '../../../auth/guard';
import { loadRelationships } from '../../../crm/relationship-data';
import { viewerTime } from '../../../time/viewer-time';
import { OperatorNotice } from '../_operator/OperatorNotice';
import { SideSummary } from '../_operator/PartyRef';

export const dynamic = 'force-dynamic';

export default async function RelationshipsPage({ searchParams }: { searchParams: { voided?: string } }) {
  await requirePermission('relationships', 'view');
  const includeVoided = searchParams.voided === '1';
  const result = await loadRelationships({ limit: 25, includeVoided });
  const time = viewerTime();

  if (result.outcome !== 'OK') {
    return (
      <div className="crm-page">
        <div className="crm-page-head"><div><h1>Relationships</h1></div></div>
        <div className="crm-panel"><p className="crm-sub">You do not have authority to read Relationships.</p></div>
      </div>
    );
  }

  const { items } = result.value;
  return (
    <div className="crm-page">
      <div className="crm-page-head">
        <div>
          <h1>Relationships</h1>
          <p className="crm-sub">
            Commercial connections somebody asserted, between established{' '}
            <Link className="crm-link" href="/crm/parties">Parties</Link>. Never inferred.
          </p>
        </div>
        {result.capabilities.create ? (
          <Link className="crm-btn" href="/crm/relationships/new">Record a Relationship</Link>
        ) : null}
      </div>

      <OperatorNotice />

      <div className="crm-panel">
        <p className="crm-sub">
          {includeVoided ? (
            <>Showing voided records too. <Link className="crm-link" href="/crm/relationships">Hide them</Link></>
          ) : (
            <>Voided records are hidden. <Link className="crm-link" href="/crm/relationships?voided=1">Show them</Link></>
          )}
        </p>
        {items.length === 0 ? (
          <p className="crm-sub">
            None yet. This is the correct answer until somebody records one — nothing will appear here
            automatically, and no legacy record becomes a Relationship on its own.
          </p>
        ) : (
          <table className="crm-table">
            <thead><tr><th>Kind</th><th>Between</th><th>State</th><th>Participants</th><th>Recorded</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.relationshipId}>
                  <td><Link className="crm-link" href={`/crm/relationships/${item.relationshipId}`}>{item.kindLabel}</Link></td>
                  <td><SideSummary sides={item.sides} structure={item.structure} /></td>
                  <td>{item.state}</td>
                  <td>{item.activeParticipantCount}</td>
                  <td>{time.monthDayTime(item.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
