// Party references, resolved -- the read side of the Party Reference Contract.
//
// Identity Slice 2.0b. The contract is `@emgloop/shared` party-reference.ts and
// the decision is docs/architecture/identity-evidence-resolution.md, section 12.
//
// READ-ONLY, AND ONLY THROUGH THE EXISTING PARTY AUTHORITY. Every record is loaded
// with `PartyRepository.findParty(organizationId, id)`. That method already:
//   - returns null for another organization, an unknown id and a non-Party type,
//     indistinguishably;
//   - decides establishment from governed provenance only.
// This file adds nothing to either. It follows supersession forward, one
// organization-scoped read per hop, and lets the pure `partyReferenceStep` decide
// every step.
//
// NEVER: a write of any kind; a lookup by name, email, phone, canonical key or
// evidence value; creating, establishing, linking or superseding a Party;
// following a reference into another organization.
//
// CaseParticipant IS NOT THIS. `CaseParticipant` (Commercial Intelligence) is a
// User's participation in a Case. It is not a Party reference, it is not the
// future CRM Participant, and this work does not rename or touch it. The CRM
// Participant authority is designed on this contract, after this slice.

import type { PrismaClient } from '@prisma/client';
import {
  PARTY_REFERENCE_NOT_FOUND,
  isPartyReference,
  partyReferenceStep,
  partyReferenceWritable,
  type PartyReference,
  type PartyReferenceNode,
  type PartyReferenceResolution,
  type PartyType,
} from '@emgloop/shared';
import { PartyRepository } from './cognitive/party.repository';

export type PartyReferenceRequirement =
  | { readonly ok: true; readonly reference: PartyReference; readonly partyType: PartyType }
  | { readonly ok: false; readonly resolution: PartyReferenceResolution };

export interface PartyReferenceRepositoryDeps {
  parties?: Pick<PartyRepository, 'findParty'>;
}

export class PartyReferenceRepository {
  private readonly parties: Pick<PartyRepository, 'findParty'>;

  constructor(prisma: PrismaClient, deps: PartyReferenceRepositoryDeps = {}) {
    this.parties = deps.parties ?? new PartyRepository(prisma);
  }

  /** What the reference (organizationId, partyId) names, superseded records resolved forward. */
  async resolve(organizationId: string, partyId: string): Promise<PartyReferenceResolution> {
    if (!isPartyReference({ organizationId, partyId })) return PARTY_REFERENCE_NOT_FOUND;
    const walked: PartyReferenceNode[] = [];
    let id = partyId;
    // `partyReferenceStep` bounds the walk (cycle and depth), so this loop ends.
    for (;;) {
      const node = await this.node(organizationId, id);
      const step = partyReferenceStep(partyId, walked, node);
      if ('resolved' in step) return step.resolved;
      if (node) walked.push(node);
      id = step.next;
    }
  }

  /**
   * The reference a writer may store: an ESTABLISHED, non-superseded,
   * non-archived Party in this organization. Anything else is refused with its
   * resolution, so a superseded id comes back with its canonical id rather than
   * being swapped for it.
   */
  async requireReferenceable(organizationId: string, partyId: string): Promise<PartyReferenceRequirement> {
    const resolution = await this.resolve(organizationId, partyId);
    if (resolution.state === 'ESTABLISHED' && partyReferenceWritable(resolution)) {
      return { ok: true, reference: { organizationId, partyId: resolution.partyId }, partyType: resolution.partyType };
    }
    return { ok: false, resolution };
  }

  private async node(organizationId: string, id: string): Promise<PartyReferenceNode | null> {
    const party = await this.parties.findParty(organizationId, id);
    if (!party) return null;
    return {
      id: party.id,
      partyType: party.partyType,
      established: party.establishment.established,
      archived: party.status === 'ARCHIVED',
      supersededByPartyId: party.supersededByIdentityId,
    };
  }
}
