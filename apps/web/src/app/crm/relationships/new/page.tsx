// Recording a Relationship. OPERATOR TOOLING, TEMPORARY.
//
// THE FORM OFFERS ONLY ESTABLISHED PARTIES, and it does not search for them by name,
// phone or email -- there is no lookup here at all, because a lookup that matched on
// a contact value would be identity resolution performed by a form. An operator
// picks from what has been established, and if nothing has been, the page says to go
// and establish something rather than offering an empty box.
//
// THE KIND VOCABULARY IS THE GOVERNED ONE (PD-F-03), read from the shared contract.
// A kind that is not in it cannot be typed in, and the service would refuse it anyway.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CRM_RELATIONSHIP_KIND_DEFINITIONS, CRM_PARTICIPANT_ROLE_DEFINITIONS } from '@emgloop/shared';
import { requirePermission } from '../../../../auth/guard';
import { loadCompanies, loadPeople } from '../../../../crm/party-data';
import { createRelationshipAction } from '../../../../crm/relationship-actions';
import { loadRelationships } from '../../../../crm/relationship-data';
import { RELATIONSHIP_OUTCOME_MESSAGES } from '../../../../crm/relationship-forms';
import { OperatorNotice, Outcome } from '../../_operator/OperatorNotice';

export const dynamic = 'force-dynamic';

export default async function NewRelationshipPage({
  searchParams,
}: {
  searchParams: { outcome?: string; refusal?: string; canonical?: string };
}) {
  await requirePermission('relationships', 'view');
  // Capabilities are the server's. A person without CREATE is sent back rather than
  // shown a form that will refuse them.
  const authority = await loadRelationships({ limit: 1 });
  if (authority.outcome !== 'OK') redirect('/crm/relationships');
  if (!authority.capabilities.create) redirect('/crm/relationships?outcome=NOT_AUTHORIZED');

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
          <h1>Record a Relationship</h1>
          <p className="crm-sub">An assertion that a commercial connection exists. Somebody is making it; Loop is not.</p>
        </div>
        <Link className="crm-link" href="/crm/relationships">Back</Link>
      </div>

      <OperatorNotice />
      <Outcome outcome={searchParams.outcome} messages={RELATIONSHIP_OUTCOME_MESSAGES} detail={refusalDetail} />

      {parties.length === 0 ? (
        <div className="crm-panel">
          <p className="crm-sub">
            No Party is established yet, and a Relationship can only be between established Parties.
            Establish one first on the <Link className="crm-link" href="/crm/parties">Parties</Link> page.
          </p>
        </div>
      ) : (
        <form action={createRelationshipAction} className="crm-panel">
          <label>
            Kind
            <select name="kind" defaultValue="CLIENT">
              {CRM_RELATIONSHIP_KIND_DEFINITIONS.map((kind) => (
                <option key={kind.kind} value={kind.kind}>
                  {kind.label} — {kind.structure === 'OWN' ? 'this workspace and one counterparty' : 'between two Parties'}
                </option>
              ))}
            </select>
          </label>
          <p className="crm-sub">
            An <strong>OWN</strong> kind has one Party side: the workspace is the other, and the workspace is
            never a Party. Fill in only the sides the kind declares — the service refuses any other shape.
          </p>

          {(['COUNTERPARTY', 'A', 'B'] as const).map((side) => (
            <fieldset key={side} className="crm-fieldset">
              <legend>Side {side}</legend>
              <label>
                Party
                <select name={`party_${side}`} defaultValue="">
                  <option value="">— not used by this kind —</option>
                  {parties.map((party) => (
                    <option key={party.partyId} value={party.partyId}>
                      {(party.displayName ?? party.partyId)} ({party.partyType})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Role in this Relationship
                <select name={`role_${side}`} defaultValue="BRAND">
                  {CRM_PARTICIPANT_ROLE_DEFINITIONS.filter((r) => r.family === 'CAPACITY').map((role) => (
                    <option key={role.role} value={role.role}>
                      {role.role} (allows {role.partyTypes.join(', ')})
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
          ))}

          <p className="crm-sub">
            A role says what a Party does here. It never changes what kind of Party it is — that stays with
            the Party authority, and a role the Party&apos;s type does not permit is refused.
          </p>
          <button className="crm-btn" type="submit">Record it</button>
        </form>
      )}
    </div>
  );
}
