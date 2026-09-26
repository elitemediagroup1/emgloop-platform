// Every intelligence producer Loop has, assembled from its ports. Loop Intelligence Phase E, 2026-09-26.
//
// ASSEMBLY IS NOT ACTIVATION. A host builds all of them and hands them to IntelligenceProducerRegistry
// with its activation list (LOOP_INTELLIGENCE_PRODUCERS); only the listed ids ever run. The model stage
// of each runs only when that producer's reading task is itself activated in the AI runtime
// (LOOP_AI_TASKS), a provider policy admits its data class, and a principal may invoke it.
//
// WHO AN ORGANIZATION READING RUNS AS. The AI runtime has no service account: every call is made as a
// person who holds the task's authority. A PRINCIPAL reading runs as that person. An ORGANIZATION reading
// runs as the operator the deployment NAMES for that organization (LOOP_INTELLIGENCE_ACTING_USERS,
// `orgId=userId` pairs), re-resolved as an ACTIVE OWNER/ADMIN/MANAGER membership on every read; no name,
// or a name that no longer qualifies, means no model call and an honest rule reading.
//
// Hosting: the Mail producers need the person's Gmail read-through (Google credentials), so they are
// assembled only where those exist (`mail` ports present); everything else reads Loop's own records.

import type { PrismaClient } from '@prisma/client';

import { createCreatorDomain } from '../../creator';
import { absentUntilMigrated } from '../../creator/until-migrated';
import { CrmRepository } from '../../repositories/crm.repository';
import { DomainFactsRepository } from '../../repositories/intelligence/domain-facts.repository';
import type { IntelligenceRefreshTarget } from '../../repositories/intelligence/intelligence-refresh-queue.repository';
import { MarketplaceCallRepository } from '../../repositories/marketplace-call.repository';
import { WebsiteAnalyticsRepository } from '../../repositories/website-analytics.repository';
import type { WorkRepository } from '../../repositories/work.repository';
import type { AiPrincipal } from '../ai-runtime/gateway';
import type { DomainReadingService } from '../ai-runtime/domain-reading.service';
import type { DomainKitPorts } from './domain-kit';
import type { IntelligenceProducer } from './producer';
import { calendarDomainProducer } from './domains/calendar';
import { callgridDomainProducer, campaignsDomainProducer } from './domains/callgrid';
import { mailDomainProducer, mailThreadProducer, type MailProducerPorts } from './domains/mail';
import { creatorsDomainProducer, crmDomainProducer, myWorkProducer, pipelineDomainProducer, websiteDomainProducer, websiteEventsReader, workDomainProducer, type WebsiteEvidenceReader } from './domains/records';

/** `orgA=user1,orgB=user2` -> a map. Malformed pairs are dropped, never guessed. */
export function parseActingUsers(raw: string | undefined | null): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const pair of String(raw ?? '').split(',')) {
    const [org, user, extra] = pair.split('=').map((s) => s.trim());
    if (org && user && extra === undefined && /^[A-Za-z0-9_-]{1,64}$/.test(org) && /^[A-Za-z0-9_-]{1,64}$/.test(user)) out.set(org, user);
  }
  return out;
}

/** The principal a target's model reading runs as (see the header), or null for none. */
export function principalResolver(facts: Pick<DomainFactsRepository, 'actingOperator'>, acting: ReadonlyMap<string, string>, now: () => Date): (target: IntelligenceRefreshTarget) => Promise<AiPrincipal | null> {
  return async (target) => {
    if (target.scope === 'PRINCIPAL') return { organizationId: target.organizationId, userId: target.userId };
    const userId = acting.get(target.organizationId);
    if (!userId) return null;
    const m = await facts.actingOperator(target.organizationId, userId, now());
    return m ? { organizationId: m.organizationId, userId: m.userId } : null;
  };
}

export interface LoopProducerPorts {
  readonly prisma: PrismaClient;
  readonly work: WorkRepository;
  readonly reader: Pick<DomainReadingService, 'read'> | null;
  readonly modelEnabled: (taskId: string) => boolean;
  readonly actingUsers: ReadonlyMap<string, string>;
  readonly now: () => Date;
  /** Present only where the person's Gmail can be read through (the runner, not the worker). */
  readonly mail?: Omit<MailProducerPorts, 'prisma' | 'modelEnabled' | 'now'>;
  /** Additional connected website evidence sources; Loop's own website events are always read. */
  readonly websiteReaders?: readonly WebsiteEvidenceReader[];
}

export function loopProducers(ports: LoopProducerPorts): IntelligenceProducer<any>[] {
  const facts = new DomainFactsRepository(ports.prisma);
  const kit: DomainKitPorts = { modelEnabled: ports.modelEnabled, reader: ports.reader, principalFor: principalResolver(facts, ports.actingUsers, ports.now) };
  const creators = createCreatorDomain(ports.prisma, ports.work);
  const roster = {
    // Creator Hub tables may not be migrated where this runs: absent is no evidence, not an error.
    roster: async (organizationId: string) => (await absentUntilMigrated(creators.records.roster(organizationId))) ?? [],
  };
  const producers: IntelligenceProducer<any>[] = [
    calendarDomainProducer(facts, kit),
    callgridDomainProducer(new MarketplaceCallRepository(ports.prisma), kit),
    campaignsDomainProducer(new MarketplaceCallRepository(ports.prisma), kit),
    pipelineDomainProducer(new CrmRepository(ports.prisma), facts, kit),
    crmDomainProducer(facts, kit),
    creatorsDomainProducer(roster, facts, kit),
    workDomainProducer(facts, kit),
    myWorkProducer(facts, kit),
    websiteDomainProducer([websiteEventsReader(new WebsiteAnalyticsRepository(ports.prisma)), ...(ports.websiteReaders ?? [])], facts, kit),
  ];
  if (ports.mail) {
    const mail: MailProducerPorts = { ...ports.mail, prisma: ports.prisma, modelEnabled: ports.modelEnabled, now: ports.now };
    producers.push(mailThreadProducer(mail), mailDomainProducer(mail, kit));
  }
  return producers;
}
