// One Relationship: who is on each side, who takes part, what happened, and what
// this reader may do about it. OPERATOR TOOLING, TEMPORARY.
//
// EVERY ACTION OFFERED IS ONE THE SERVER SAID THIS PERSON MAY PERFORM, from the
// capabilities the read model returned. That is not the security boundary -- the
// service authorizes again when the form is submitted -- it is how the page avoids
// re-deriving authorization rules it cannot be trusted with. Hiding a button was
// never access control, and showing one is never permission.
//
// THE HONEST STATES ARE THE POINT. A superseded side shows both ids. An unavailable
// reference says it cannot be followed. A duplicate diagnostic is reported for a
// person to resolve, with no merge offered, because merging two Relationships
// automatically would be identity resolution performed by a screen.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CRM_PARTICIPANT_ROLE_DEFINITIONS } from '@emgloop/shared';
import { requirePermission } from '../../../../auth/guard';
import { loadCompanies, loadPeople } from '../../../../crm/party-data';
import {
  addParticipantAction,
  endParticipantAction,
  endRelationshipAction,
  reactivateRelationshipAction,
  voidParticipantAction,
  voidRelationshipAction,
} from '../../../../crm/relationship-actions';
import { loadRelationship } from '../../../../crm/relationship-data';
import { RELATIONSHIP_OUTCOME_MESSAGES } from '../../../../crm/relationship-forms';
import { viewerTime } from '../../../../time/viewer-time';
import { OperatorNotice, Outcome } from '../../_operator/OperatorNotice';
import { PartyRef } from '../../_operator/PartyRef';

export const dynamic = 'force-dynamic';

export default async function RelationshipPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { outcome?: string; refusal?: string; canonical?: string };
}) {
  await requirePermission('relationships', 'view');
  const result = await loadRelationship(params.id);
  // Another tenant's id and one that never existed answer the same way.
  if (result.outcome === 'NOT_FOUND' || result.outcome === 'NOT_AUTHORIZED') notFound();
  if (result.outcome !== 'OK') notFound();

  const record = result.value;
  const may = result.capabilities;
  const time = viewerTime();
  const [people, companies] = await Promise.all([loadPeople({ limit: 100 }), loadCompanies({ limit: 100 })]);
  const parties = [
    ...(people.outcome === 'OK' ? people.value.items : []),
    ...(companies.outcome === 'OK' ? companies.value.items : []),
  ];

  const refusalDetail = searchParams.refusal
    ? `${RELATIONSHIP_OUTCOME_MESSAGES[`PARTY_${searchParams.refusal}`] ?? searchParams.refusal}${
        searchParams.canonical ? ` Canonical id: ${searchParams.canonical}` : ''
      }`
    : undefined;

  return (
    <div className="crm-page">
      <div className="crm-page-head">
        <div>
          <h1>{record.kindLabel}</h1>
          <p className="crm-sub">{record.state} · recorded {time.monthDayTime(record.createdAt)}</p>
        </div>
        <Link className="crm-link" href="/crm/relationships">Back</Link>
      </div>

      <OperatorNotice />
      <Outcome outcome={searchParams.outcome} messages={RELATIONSHIP_OUTCOME_MESSAGES} detail={refusalDetail} />

      <div className="crm-panel">
        <h2 className="crm-h2">Sides</h2>
        {record.structure === 'OWN' ? (
          <p className="crm-sub">
            An OWN relationship. <strong>This workspace is the other side</strong>, and it is not a Party —
            no record exists for it and none is created.
          </p>
        ) : null}
        <table className="crm-table">
          <thead><tr><th>Side</th><th>Reads as</th><th>Party</th><th>Role</th></tr></thead>
          <tbody>
            {record.sides.map((side) => (
              <tr key={side.side}>
                <td>{side.side}</td>
                <td>{side.label}</td>
                <td><PartyRef view={side.party} /></td>
                <td>{side.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="crm-sub">
          A side is fixed when the Relationship is recorded. Correcting one means voiding this record and
          recording it again — a Relationship between different Parties is a different fact.
        </p>
      </div>

      {record.duplicates.length > 0 ? (
        <div className="crm-panel">
          <h2 className="crm-h2">Possible duplicate</h2>
          <p className="crm-sub">
            {record.duplicates.length} other non-voided {record.kindLabel} record
            {record.duplicates.length === 1 ? '' : 's'} resolve to the same canonical Parties, usually after a
            supersession. <strong>Loop reports this and changes nothing.</strong> A person decides, by ending
            or voiding one with a reason.
          </p>
          <ul>
            {record.duplicates.map((d) => (
              <li key={d.relationshipId}>
                <Link className="crm-link" href={`/crm/relationships/${d.relationshipId}`}>{d.relationshipId}</Link> ({d.state})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="crm-panel">
        <h2 className="crm-h2">Participants ({record.participants.length})</h2>
        <table className="crm-table">
          <thead><tr><th>Party</th><th>Role</th><th>Fills / acts for</th><th>State</th><th></th></tr></thead>
          <tbody>
            {record.participants.map((p) => (
              <tr key={p.participantId}>
                <td><PartyRef view={p.party} /></td>
                <td>{p.role} <span className="crm-sub">({p.roleFamily.toLowerCase()})</span></td>
                <td>{p.side ? `fills side ${p.side}` : `acts for side ${p.actsForSide}`}</td>
                <td>
                  {p.state}
                  {p.reasonRecorded ? <span className="crm-sub"> · a reason was recorded</span> : null}
                </td>
                <td>
                  {p.side !== null ? (
                    <span className="crm-sub">A side cannot be ended on its own</span>
                  ) : p.state !== 'ACTIVE' ? null : (
                    <>
                      {may.endParticipant ? (
                        <form action={endParticipantAction} className="crm-form-row">
                          <input type="hidden" name="relationshipId" value={record.relationshipId} />
                          <input type="hidden" name="participantId" value={p.participantId} />
                          <input name="reason" type="text" required placeholder="Why it ended (kept)" />
                          <button className="crm-btn" type="submit">End</button>
                        </form>
                      ) : null}
                      {may.voidParticipant ? (
                        <form action={voidParticipantAction} className="crm-form-row">
                          <input type="hidden" name="relationshipId" value={record.relationshipId} />
                          <input type="hidden" name="participantId" value={p.participantId} />
                          <input name="reason" type="text" required placeholder="Why it was never true" />
                          <button className="crm-btn" type="submit">Void</button>
                        </form>
                      ) : null}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {may.addParticipant && record.state === 'ACTIVE' && parties.length > 0 ? (
          <form action={addParticipantAction} className="crm-form-row">
            <input type="hidden" name="relationshipId" value={record.relationshipId} />
            <label>
              Party
              <select name="partyId" defaultValue="">
                <option value="">— choose an established Party —</option>
                {parties.map((party) => (
                  <option key={party.partyId} value={party.partyId}>
                    {(party.displayName ?? party.partyId)} ({party.partyType})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Role
              <select name="role" defaultValue="PRIMARY_CONTACT">
                {CRM_PARTICIPANT_ROLE_DEFINITIONS.map((role) => (
                  <option key={role.role} value={role.role}>{role.role} (allows {role.partyTypes.join(', ')})</option>
                ))}
              </select>
            </label>
            <label>
              Acts for side
              <select name="actsForSide" defaultValue={record.sides[0]?.side ?? 'A'}>
                {record.sides.map((s) => <option key={s.side} value={s.side}>{s.side} — {s.label}</option>)}
              </select>
            </label>
            <button className="crm-btn" type="submit">Add participant</button>
          </form>
        ) : null}
      </div>

      <div className="crm-panel">
        <h2 className="crm-h2">Lifecycle</h2>
        <div className="crm-form-row">
          {may.endRelationship && record.state === 'ACTIVE' ? (
            <form action={endRelationshipAction} className="crm-form-row">
              <input type="hidden" name="relationshipId" value={record.relationshipId} />
              <input name="reason" type="text" required placeholder="Why it ended (kept on the record)" />
              <button className="crm-btn" type="submit">End</button>
            </form>
          ) : null}
          {may.reactivateRelationship && record.state === 'ENDED' ? (
            <form action={reactivateRelationshipAction}>
              <input type="hidden" name="relationshipId" value={record.relationshipId} />
              <button className="crm-btn" type="submit">Reactivate</button>
            </form>
          ) : null}
          {may.voidRelationship && record.state !== 'VOIDED' ? (
            <form action={voidRelationshipAction} className="crm-form-row">
              <input type="hidden" name="relationshipId" value={record.relationshipId} />
              <input name="reason" type="text" required placeholder="Why it was never true" />
              <button className="crm-btn" type="submit">Void</button>
            </form>
          ) : null}
        </div>
        <p className="crm-sub">
          Ending says it was true and has stopped; voiding says it was never true. Neither deletes
          anything. A voided record stays readable and releases its key, so the same connection can be
          recorded again.
        </p>
      </div>

      <div className="crm-panel">
        <h2 className="crm-h2">History ({record.history.length})</h2>
        <table className="crm-table">
          <thead><tr><th>#</th><th>What</th><th>When it happened</th><th>When Loop recorded it</th><th>Who</th></tr></thead>
          <tbody>
            {record.history.map((h) => (
              <tr key={h.sequence}>
                <td>{h.sequence}</td>
                <td>
                  {h.type.toLowerCase().replace(/_/g, ' ')}
                  {h.fromState || h.toState ? <span className="crm-sub"> · {h.fromState ?? '—'} → {h.toState ?? '—'}</span> : null}
                  {h.reasonRecorded ? <span className="crm-sub"> · a reason was recorded on the event</span> : null}
                </td>
                <td>{time.monthDayTime(h.occurredAt)} <span className="crm-sub">({h.occurredAtBasis})</span></td>
                <td>{time.monthDayTime(h.recordedAt)}</td>
                <td>{h.actorUserId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="crm-sub">
          Append-only. Nothing in this list can be edited or removed, and the state above is what folding
          it produces.
        </p>
      </div>
    </div>
  );
}
