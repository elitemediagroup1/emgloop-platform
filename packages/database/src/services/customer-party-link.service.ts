// CustomerPartyLinkService -- governed links from Customer records to canonical
// Parties. CRM Phase Zero P0.2e.
//
// THE PRODUCT RULES THIS ENFORCES (locked 2026-09-13):
//
//   1-2. Creating and reversing a link both require identityResolution:approve.
//   3.   The target Party must already be ESTABLISHED.
//   4.   Linking never establishes a Party -- not implicitly, not as a side effect.
//   5.   Legacy Customer data is not identity authority: nothing here reads a
//        Customer's email, phone, name or external id to decide anything.
//   6.   History and provenance are kept; there is no silent relinking and no
//        destructive overwrite. A Customer with an active link to one Party cannot
//        be linked to another until that link is reversed, with a reason.
//   7.   Cross-organization links fail closed, indistinguishably from a miss.
//   8.   No automatic linking of any kind. Every link is one person's act.
//   9.   No screens. The actor is always the session's user, supplied by the
//        caller from the session.
//
// AUTHORIZE BEFORE LOOKING. Authority is checked before any Customer or Party is
// read, so a person without it cannot use this service to learn whether either
// exists. Writes are audited only when they happened.
//
// NOT CALLABLE FROM INGESTION. Webhook and sync routes resolve their organization
// from a hard-coded slug; a link written there would land in one tenant. No
// ingestion path imports this service (a test enforces it).
//
// A LINK HAS NO SIDE EFFECTS. It creates no Opportunity, Relationship, Campaign,
// Case, Headline, Finding or Work, and it never touches the Party it points at.

import type { CustomerPartyLink, PrismaClient } from '@prisma/client';

import { IamRepository } from '../repositories/iam.repository';
import { AuditRepository } from '../repositories/audit.repository';
import { PartyRepository } from '../repositories/cognitive/party.repository';
import { CustomerPartyLinkRepository } from '../repositories/customer-party-link.repository';

export const CUSTOMER_PARTY_LINK_OUTCOMES = [
  'LINKED',
  'ALREADY_LINKED',
  'REVERSED',
  'NOT_AUTHORIZED',
  'NOT_FOUND',
  'PARTY_NOT_ESTABLISHED',
  'PARTY_SUPERSEDED',
  'CUSTOMER_MERGED',
  'CONFLICTING_ACTIVE_LINK',
  'NO_ACTIVE_LINK',
  'INVALID',
] as const;
export type CustomerPartyLinkOutcome = (typeof CUSTOMER_PARTY_LINK_OUTCOMES)[number];

export type CustomerPartyLinkResult =
  | { outcome: 'LINKED' | 'ALREADY_LINKED' | 'REVERSED'; link: CustomerPartyLink }
  | {
      outcome:
        | 'NOT_AUTHORIZED'
        | 'NOT_FOUND'
        | 'PARTY_NOT_ESTABLISHED'
        | 'PARTY_SUPERSEDED'
        | 'CUSTOMER_MERGED'
        | 'CONFLICTING_ACTIVE_LINK'
        | 'NO_ACTIVE_LINK';
    }
  | { outcome: 'INVALID'; reason: 'NOT_A_GOVERNED_BASIS' | 'REASON_REQUIRED' };

export interface CustomerPartyLinkDeps {
  iam?: Pick<IamRepository, 'can'>;
  parties?: PartyRepository;
  links?: CustomerPartyLinkRepository;
  audit?: Pick<AuditRepository, 'record'>;
}

export const CUSTOMER_PARTY_LINK_BASES = ['MANUAL', 'EXPLICIT_LINK'] as const;
const REASON_MAX = 500;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

export class CustomerPartyLinkService {
  private readonly iam: Pick<IamRepository, 'can'>;
  private readonly parties: PartyRepository;
  private readonly links: CustomerPartyLinkRepository;
  private readonly audit: Pick<AuditRepository, 'record'>;

  constructor(prisma: PrismaClient, deps: CustomerPartyLinkDeps = {}) {
    this.iam = deps.iam ?? new IamRepository(prisma);
    this.parties = deps.parties ?? new PartyRepository(prisma);
    this.links = deps.links ?? new CustomerPartyLinkRepository(prisma);
    this.audit = deps.audit ?? new AuditRepository(prisma);
  }

  /** The question both writes ask. */
  canLink(organizationId: string, actorUserId: string): Promise<boolean> {
    return this.iam.can({ organizationId, userId: actorUserId, resource: 'identityResolution', action: 'approve' });
  }

  /** Link a Customer record to an established Party. */
  async link(
    organizationId: string,
    actorUserId: string,
    input: { customerId: string; partyId: string; basis?: string },
  ): Promise<CustomerPartyLinkResult> {
    const basis = input.basis ?? 'MANUAL';
    if (!(CUSTOMER_PARTY_LINK_BASES as readonly string[]).includes(basis)) {
      return { outcome: 'INVALID', reason: 'NOT_A_GOVERNED_BASIS' };
    }
    if (!(await this.canLink(organizationId, actorUserId))) return { outcome: 'NOT_AUTHORIZED' };

    const customer = await this.links.customerState(organizationId, input.customerId);
    if (!customer) return { outcome: 'NOT_FOUND' };
    if (customer.mergedInto) return { outcome: 'CUSTOMER_MERGED' };

    const party = await this.parties.findParty(organizationId, input.partyId);
    if (!party) return { outcome: 'NOT_FOUND' };
    if (party.supersededByIdentityId) return { outcome: 'PARTY_SUPERSEDED' };
    if (!party.establishment.established) return { outcome: 'PARTY_NOT_ESTABLISHED' };

    const active = await this.links.findActive(organizationId, customer.id);
    if (active) {
      return active.partyId === party.id
        ? { outcome: 'ALREADY_LINKED', link: active }
        : { outcome: 'CONFLICTING_ACTIVE_LINK' };
    }

    let link: CustomerPartyLink;
    try {
      link = await this.links.create(organizationId, {
        customerId: customer.id,
        partyId: party.id,
        basis: basis as (typeof CUSTOMER_PARTY_LINK_BASES)[number],
        linkedByUserId: actorUserId,
        linkedAt: new Date(),
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Someone linked this Customer between the read and the write. Their link
      // stands; nothing is overwritten and nothing is audited.
      const winner = await this.links.findActive(organizationId, customer.id);
      if (winner && winner.partyId === party.id) return { outcome: 'ALREADY_LINKED', link: winner };
      return { outcome: 'CONFLICTING_ACTIVE_LINK' };
    }

    await this.audit.record({
      organizationId,
      userId: actorUserId,
      action: 'customer.party_linked',
      entityType: 'customer',
      entityId: customer.id,
      metadata: { linkId: link.id, partyId: party.id, basis },
    });
    return { outcome: 'LINKED', link };
  }

  /** Reverse a Customer's active link, recording who and why. The row is kept. */
  async reverse(
    organizationId: string,
    actorUserId: string,
    input: { customerId: string; reason: string },
  ): Promise<CustomerPartyLinkResult> {
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, REASON_MAX) : '';
    if (reason.length === 0) return { outcome: 'INVALID', reason: 'REASON_REQUIRED' };
    if (!(await this.canLink(organizationId, actorUserId))) return { outcome: 'NOT_AUTHORIZED' };

    const customer = await this.links.customerState(organizationId, input.customerId);
    if (!customer) return { outcome: 'NOT_FOUND' };
    const active = await this.links.findActive(organizationId, customer.id);
    if (!active) return { outcome: 'NO_ACTIVE_LINK' };

    const reversed = await this.links.reverse(organizationId, active.id, {
      reversedByUserId: actorUserId,
      reason,
      at: new Date(),
    });
    if (!reversed) return { outcome: 'NO_ACTIVE_LINK' };

    await this.audit.record({
      organizationId,
      userId: actorUserId,
      action: 'customer.party_link_reversed',
      entityType: 'customer',
      entityId: customer.id,
      metadata: { linkId: reversed.id, partyId: reversed.partyId },
    });
    return { outcome: 'REVERSED', link: reversed };
  }

  /**
   * The Customer's links, for someone who may see identity resolution. An
   * unauthorized reader and a missing Customer both get null.
   */
  async history(organizationId: string, actorUserId: string, customerId: string): Promise<CustomerPartyLink[] | null> {
    const allowed = await this.iam.can({ organizationId, userId: actorUserId, resource: 'identityResolution', action: 'view' });
    if (!allowed) return null;
    const customer = await this.links.customerState(organizationId, customerId);
    if (!customer) return null;
    return this.links.history(organizationId, customer.id);
  }
}
