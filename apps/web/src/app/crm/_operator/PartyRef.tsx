// How a Party reference reads on a screen, in every state it can be in.
//
// THE POINT OF THIS COMPONENT IS THE STATES NOBODY LIKES. An established Party is
// easy. What matters is that a SUPERSEDED reference shows the id the record was
// written with AND the canonical one -- because Loop resolves forward for a reader
// and refuses for a writer, and hiding either half would make one of those two
// behaviours inexplicable. And that an UNAVAILABLE reference says so plainly instead
// of rendering an empty cell that reads as "nobody".

import type { CrmPartyReferenceViewV1, CrmRelationshipSideViewV1 } from '@emgloop/shared';

export function PartyRef({ view }: { view: CrmPartyReferenceViewV1 }) {
  if (view.state === 'ESTABLISHED') {
    return (
      <span>
        {view.partyId}
        {view.archived ? <span className="crm-sub"> · archived (readable, takes no new references)</span> : null}
      </span>
    );
  }
  if (view.state === 'SUPERSEDED') {
    return (
      <span>
        {view.partyId}
        <span className="crm-sub">
          {' '}· superseded → canonical {view.canonicalPartyId}
          {view.canonicalArchived ? ' (archived)' : ''}
          {' '}· writes must name the canonical id explicitly
        </span>
      </span>
    );
  }
  if (view.state === 'NOT_ESTABLISHED') {
    return <span>{view.partyId}<span className="crm-sub"> · not established</span></span>;
  }
  return (
    <span>
      {view.partyId}
      <span className="crm-sub"> · unavailable — this reference cannot be followed safely, and nothing is guessed</span>
    </span>
  );
}

/** One line for a list: who is on each side, and how the side reads. */
export function SideSummary({
  sides, structure,
}: {
  sides: readonly CrmRelationshipSideViewV1[];
  structure: string;
}) {
  if (sides.length === 0) return <span className="crm-sub">—</span>;
  return (
    <span>
      {structure === 'OWN' ? <span className="crm-sub">this workspace · </span> : null}
      {sides.map((side, i) => (
        <span key={side.side}>
          {i > 0 ? <span className="crm-sub"> · </span> : null}
          <span className="crm-sub">{side.label}: </span>
          <PartyRef view={side.party} />
        </span>
      ))}
    </span>
  );
}
