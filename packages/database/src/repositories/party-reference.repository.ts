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
import { PartyRepository, type PartyView } from './cognitive/party.repository';

export type PartyReferenceRequirement =
  | { readonly ok: true; readonly reference: PartyReference; readonly partyType: PartyType }
  | { readonly ok: false; readonly resolution: PartyReferenceResolution };

export interface PartyReferenceRepositoryDeps {
  parties?: Pick<PartyRepository, 'findParty'> & Partial<Pick<PartyRepository, 'findParties'>>;
}

export class PartyReferenceRepository {
  private readonly parties: Pick<PartyRepository, 'findParty'> & Partial<Pick<PartyRepository, 'findParties'>>;

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
   * `resolve` for many references at once: the first hop of every chain is read in one batch,
   * and only a superseded record walks further, one hop at a time, exactly as `resolve` does
   * (the same `partyReferenceStep`, so the bounds and refusals are the same). Built for list
   * pages, which must not ask once per row. Every requested id gets an answer.
   */
  async resolveMany(organizationId: string, partyIds: readonly string[]): Promise<Map<string, PartyReferenceResolution>> {
    const unique = [...new Set(partyIds)];
    const out = new Map<string, PartyReferenceResolution>();
    const first = this.parties.findParties && organizationId?.trim()
      ? await this.parties.findParties(organizationId, unique.filter((id) => isPartyReference({ organizationId, partyId: id })))
      : new Map<string, PartyView>();
    for (const partyId of unique) {
      if (!isPartyReference({ organizationId, partyId })) {
        out.set(partyId, PARTY_REFERENCE_NOT_FOUND);
        continue;
      }
      const walked: PartyReferenceNode[] = [];
      let id = partyId;
      for (;;) {
        const preloaded = first.get(id);
        const node = preloaded ? nodeFrom(preloaded) : this.parties.findParties && walked.length === 0 ? null : await this.node(organizationId, id);
        const step = partyReferenceStep(partyId, walked, node);
        if ('resolved' in step) {
          out.set(partyId, step.resolved);
          break;
        }
        if (node) walked.push(node);
        id = step.next;
      }
    }
    return out;
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
    return party ? nodeFrom(party) : null;
  }
}

function nodeFrom(party: PartyView): PartyReferenceNode {
  return {
    id: party.id,
    partyType: party.partyType,
    established: party.establishment.established,
    archived: party.status === 'ARCHIVED',
    supersededByPartyId: party.supersededByIdentityId,
  };
}
