// Possible New People: the human acts (CRM slice 6). Decision record: docs/architecture/crm-people-command-center.md.
//
// ADD TO PEOPLE IS A PERSON'S ACT, THROUGH THE EXISTING AUTHORITIES, AND NOTHING ELSE:
//   1. re-read the candidate from the viewer's OWN mail (the address is never taken from the form:
//      the form carries only the viewer's own correspondent hash);
//   2. re-check the exact state NOW: an address an INDIVIDUAL Contact Point already holds is
//      ALREADY_EXISTS (with that Person, to open); one a Company's ROLE_INBOX / UNATTRIBUTED point holds
//      is REATTRIBUTION_REQUIRED -- never silently converted into a Person;
//   3. in ONE transaction: PartyService.create (PERSON) + establish (MANUAL, which needs
//      identityResolution:approve), CrmContactPointService.add (EMAIL, INDIVIDUAL, OPERATOR_RECORDED),
//      and an ORIGIN fact "Human-approved from Gmail discovery" -- each with its own grant, audit row
//      and outbox event. A refusal at any step rolls all of it back.
// NO Opportunity, Relationship, Participant, affiliation or Company is created -- not from the
// address's domain, not from anything. The Person's history appears because their address now links
// exactly; nothing is copied.
//
// DISMISS / RESTORE are the viewer's private preferences over their own queue, and need no CRM grant
// beyond seeing it. They are not audited: like suppressing a sender in Mail, they describe one person's
// mailbox, and an audit row would put that into an organization-visible record.

import type { PrismaClient } from '@prisma/client';
import {
  CRM_ORIGIN_GMAIL_DISCOVERY,
  isCrmDiscoveryDismissReason,
  normalizeCrmContactPointValue,
  type CrmDiscoveryDismissReason,
} from '@emgloop/shared';

import { IamRepository } from '../repositories/iam.repository';
import { CrmContactPointRepository, crmContactPointValueHash } from '../repositories/crm-contact-point.repository';
import { WorkOutreachRepository } from '../repositories/work-state/work-outreach.repository';
import { PartyService } from '../services/party.service';
import { CrmContactPointService } from '../services/crm-contact-point.service';
import { crmOutreachRole, type CrmOutreachActor } from './crm-outreach-access';
import { CrmOutreachService } from './crm-outreach.service';

export type CrmDiscoveryAddResult =
  | { readonly outcome: 'ADDED'; readonly partyId: string }
  | { readonly outcome: 'ALREADY_EXISTS'; readonly partyId: string }
  | { readonly outcome: 'REATTRIBUTION_REQUIRED'; readonly companyPartyId: string | null }
  | { readonly outcome: 'NOT_AUTHORIZED' | 'NOT_FOUND' | 'NAME_REQUIRED' | 'ADDRESS_INVALID' | 'AMBIGUOUS' }
  | { readonly outcome: 'REFUSED'; readonly step: 'PARTY_CREATE' | 'PARTY_ESTABLISH' | 'CONTACT_POINT'; readonly code: string };

export interface CrmDiscoveryServiceDeps {
  work?: WorkOutreachRepository;
  parties?: PartyService;
  contactPoints?: CrmContactPointService;
  contactPointRows?: Pick<CrmContactPointRepository, 'currentHoldersDetailed'>;
  outreach?: CrmOutreachService;
  iam?: Pick<IamRepository, 'canEach'>;
  clock?: () => Date;
}

class AddRefused extends Error {
  constructor(readonly result: CrmDiscoveryAddResult) {
    super('add refused');
  }
}

const NAME_MAX = 120;

export class CrmPeopleDiscoveryService {
  private readonly work: WorkOutreachRepository;
  private readonly parties: PartyService;
  private readonly contactPoints: CrmContactPointService;
  private readonly contactPointRows: Pick<CrmContactPointRepository, 'currentHoldersDetailed'>;
  private readonly outreach: CrmOutreachService;
  private readonly iam: Pick<IamRepository, 'canEach'>;
  private readonly clock: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmDiscoveryServiceDeps = {},
  ) {
    this.work = deps.work ?? new WorkOutreachRepository(prisma);
    this.parties = deps.parties ?? new PartyService(prisma);
    this.contactPoints = deps.contactPoints ?? new CrmContactPointService(prisma);
    this.contactPointRows = deps.contactPointRows ?? new CrmContactPointRepository(prisma);
    this.outreach = deps.outreach ?? new CrmOutreachService(prisma);
    this.iam = deps.iam ?? new IamRepository(prisma);
    this.clock = deps.clock ?? (() => new Date());
  }

  /** Whether the viewer may use their own queue at all: People visible, and their own mail readable. */
  private async mayUseQueue(actor: CrmOutreachActor): Promise<boolean> {
    const role = await crmOutreachRole(this.prisma, this.iam, actor);
    if (!role) return false;
    const [mail] = await this.iam.canEach(actor.organizationId, actor.userId, [{ resource: 'employeeIntelligence', action: 'view' }]);
    return mail === true;
  }

  /**
   * What adding this candidate would do, re-checked now: the proposed name and address, and whether
   * the address is already held. The address comes from the viewer's own correspondent row.
   */
  async preview(actor: CrmOutreachActor, correspondentHash: string): Promise<
    | { readonly outcome: 'NOT_AUTHORIZED' | 'NOT_FOUND' | 'ADDRESS_INVALID' }
    | { readonly outcome: 'OK'; readonly address: string; readonly displayName: string | null; readonly existing: CrmDiscoveryAddResult | null }
  > {
    if (!(await this.mayUseQueue(actor))) return { outcome: 'NOT_AUTHORIZED' };
    const c = await this.work.correspondent(actor, correspondentHash);
    if (!c) return { outcome: 'NOT_FOUND' };
    const n = normalizeCrmContactPointValue('EMAIL', c.displayAddress);
    if (!n.ok) return { outcome: 'ADDRESS_INVALID' };
    return { outcome: 'OK', address: n.value, displayName: c.displayName, existing: await this.existing(actor.organizationId, n.value) };
  }

  /** Add the candidate as a Person, as described above. `name` is what the person confirmed or typed. */
  async add(actor: CrmOutreachActor, correspondentHash: string, name: string): Promise<CrmDiscoveryAddResult> {
    if (!(await this.mayUseQueue(actor))) return { outcome: 'NOT_AUTHORIZED' };
    const displayName = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
    if (displayName.length < 2 || displayName.length > NAME_MAX || /[@<>]/.test(displayName)) return { outcome: 'NAME_REQUIRED' };
    const c = await this.work.correspondent(actor, correspondentHash);
    if (!c) return { outcome: 'NOT_FOUND' };
    const n = normalizeCrmContactPointValue('EMAIL', c.displayAddress);
    if (!n.ok) return { outcome: 'ADDRESS_INVALID' };
    const before = await this.existing(actor.organizationId, n.value);
    if (before) return before;

    const at = this.clock();
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const created = await this.parties.create(actor.organizationId, actor.userId, { partyType: 'PERSON', displayName }, { tx });
          if (created.outcome !== 'RECORDED') throw new AddRefused(created.outcome === 'NOT_AUTHORIZED' ? { outcome: 'NOT_AUTHORIZED' } : { outcome: 'REFUSED', step: 'PARTY_CREATE', code: created.outcome });
          const established = await this.parties.establish(actor.organizationId, actor.userId, created.party.id, 'MANUAL', { tx });
          if (established.outcome !== 'RECORDED') throw new AddRefused(established.outcome === 'NOT_AUTHORIZED' ? { outcome: 'NOT_AUTHORIZED' } : { outcome: 'REFUSED', step: 'PARTY_ESTABLISH', code: established.outcome });
          const point = await this.contactPoints.add(actor, { partyId: created.party.id, kind: 'EMAIL', classification: 'INDIVIDUAL', value: n.value, basis: 'OPERATOR_RECORDED' }, { tx });
          if (point.outcome !== 'RECORDED') {
            if (point.outcome === 'NOT_AUTHORIZED') throw new AddRefused({ outcome: 'NOT_AUTHORIZED' });
            // A concurrent add took the address between the check and this write.
            throw new AddRefused({ outcome: 'REFUSED', step: 'CONTACT_POINT', code: point.outcome });
          }
          await this.outreach.recordOriginIn(tx, actor, created.party.id, 'PERSON', CRM_ORIGIN_GMAIL_DISCOVERY, at);
          return { outcome: 'ADDED' as const, partyId: created.party.id };
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
    } catch (err) {
      if (err instanceof AddRefused) {
        // Re-check: a concurrent add of the same address is ALREADY_EXISTS, not a failure.
        if (err.result.outcome === 'REFUSED' && err.result.step === 'CONTACT_POINT') return (await this.existing(actor.organizationId, n.value)) ?? err.result;
        return err.result;
      }
      throw err;
    }
  }

  async dismiss(actor: CrmOutreachActor, correspondentHash: string, reason: CrmDiscoveryDismissReason): Promise<'DISMISSED' | 'NOT_AUTHORIZED' | 'NOT_FOUND' | 'INVALID'> {
    if (!isCrmDiscoveryDismissReason(reason)) return 'INVALID';
    if (!(await this.mayUseQueue(actor))) return 'NOT_AUTHORIZED';
    const c = await this.work.correspondent(actor, correspondentHash);
    if (!c) return 'NOT_FOUND';
    return (await this.work.dismiss(actor, c.addressHash, reason, this.clock())) ? 'DISMISSED' : 'NOT_FOUND';
  }

  async restore(actor: CrmOutreachActor, correspondentHash: string): Promise<'RESTORED' | 'NOT_AUTHORIZED' | 'NOT_FOUND'> {
    if (!(await this.mayUseQueue(actor))) return 'NOT_AUTHORIZED';
    return (await this.work.restore(actor, correspondentHash, this.clock())) ? 'RESTORED' : 'NOT_FOUND';
  }

  /** Who holds this exact address now, as an add outcome; null when nobody does. */
  private async existing(organizationId: string, normalized: string): Promise<CrmDiscoveryAddResult | null> {
    const holders = await this.contactPointRows.currentHoldersDetailed(organizationId, 'EMAIL', crmContactPointValueHash(organizationId, 'EMAIL', normalized));
    if (holders.length === 0) return null;
    const parties = [...new Set(holders.map((h) => h.partyId))];
    if (parties.length > 1) return { outcome: 'AMBIGUOUS' };
    const h = holders[0]!;
    if (h.classification === 'INDIVIDUAL' && h.partyType === 'PERSON') return { outcome: 'ALREADY_EXISTS', partyId: h.partyId };
    return { outcome: 'REATTRIBUTION_REQUIRED', companyPartyId: h.partyType === 'COMPANY' ? h.partyId : null };
  }
}
