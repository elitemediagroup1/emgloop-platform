// Interactive, read-only snapshots through the same domain readers as scheduled intelligence.
// No discovery, enqueue, digest writes, or nested model calls. Stored source coverage remains partial.
import type { PrismaClient } from '@prisma/client';
import { INTELLIGENCE_DOMAIN_REGISTRY, mailContentGovernance } from '@emgloop/shared';
import { membershipAuthority } from '../../repositories/membership.repository';
import { WorkRepository } from '../../repositories/work.repository';
import type { AiPrincipal } from '../ai-runtime/gateway';
import { readableOrganizationDomains, type BriefingArtifact } from './briefing';
import { loopProducers } from './loop-producers';
import type { IntelligenceProducer } from './producer';
import type { MailThreadRead } from './domains/mail';

export interface ChatSourceOptions {
  readonly signal?: AbortSignal;
  readonly question: string;
  readonly since: Date;
  readonly until: Date;
}
export interface ChatSourcePorts {
  readonly governanceDecision?: string | null;
  readonly producers?: readonly IntelligenceProducer<any>[];
  readonly readMailThread?: (principal: AiPrincipal, id: string) => Promise<MailThreadRead | null>;
}

export class LoopChatSources {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ports: ChatSourcePorts = {},
  ) {}

  async gather(
    principal: AiPrincipal,
    now: Date,
    options: ChatSourceOptions,
  ): Promise<BriefingArtifact[]> {
    if (
      options.signal?.aborted ||
      !(await membershipAuthority(this.prisma, principal.organizationId, principal.userId)).granted
    )
      return [];
    const allowed = await readableOrganizationDomains(
      this.prisma,
      principal.organizationId,
      principal.userId,
    );
    const producers =
      this.ports.producers ??
      loopProducers({
        prisma: this.prisma,
        work: new WorkRepository(this.prisma),
        reader: null,
        modelEnabled: () => false,
        actingUsers: new Map(),
        now: () => now,
      });
    const google = await this.prisma.googleConnection.findFirst({
      where: principal,
      select: { status: true },
    });
    const permitted = producers.filter(
      (p) =>
        p.subjectKinds.includes('DOMAIN') &&
        (p.scope === 'ORGANIZATION'
          ? allowed.includes(p.domain)
          : p.domain === 'WORK' || (p.domain === 'CALENDAR' && google?.status === 'CONNECTED')),
    );
    const snapshots = await Promise.all(
      permitted.map((p) => this.snapshot(p, principal, now, options.signal)),
    );
    if (options.signal?.aborted) return [];
    if (/\b(mail|emails?|inbox)\b/i.test(options.question))
      snapshots.push(...(await this.mail(principal, now, options)));
    // Revoked membership or domain permission during retrieval must not publish the captured snapshot.
    if (
      options.signal?.aborted ||
      !(await membershipAuthority(this.prisma, principal.organizationId, principal.userId)).granted
    )
      return [];
    const stillAllowed = await readableOrganizationDomains(
      this.prisma,
      principal.organizationId,
      principal.userId,
    );
    return snapshots.filter(
      (a): a is BriefingArtifact =>
        !!a && (!allowed.some((d) => d === a.domain) || stillAllowed.some((d) => d === a.domain)),
    );
  }

  private async snapshot(
    p: IntelligenceProducer<any>,
    principal: AiPrincipal,
    now: Date,
    signal?: AbortSignal,
  ): Promise<BriefingArtifact | null> {
    if (signal?.aborted) return null;
    const target =
      p.scope === 'PRINCIPAL'
        ? {
            scope: 'PRINCIPAL' as const,
            ...principal,
            domain: p.domain,
            subjectKind: 'DOMAIN' as const,
            subjectRef: 'domain',
          }
        : {
            scope: 'ORGANIZATION' as const,
            organizationId: principal.organizationId,
            domain: p.domain,
            subjectKind: 'DOMAIN' as const,
            subjectRef: 'domain',
          };
    try {
      const gathered = await p.gather(target, now);
      if (signal?.aborted || gathered.status !== 'READY') return null;
      const read = await p.read(target, gathered.context, gathered.fingerprint, now);
      if (signal?.aborted || read.status !== 'READ') return null;
      const d = read.digest;
      return {
        ref: `snapshot:${p.id.replace('@', ':')}`,
        domain: p.domain,
        title: `${p.scope === 'PRINCIPAL' ? 'Your ' : ''}${INTELLIGENCE_DOMAIN_REGISTRY.find((r) => r.domain === p.domain)?.label ?? p.domain}: stored records`,
        statement: d.content.reading?.statement ?? d.content.synthesis ?? '',
        status: d.content.reading?.status ?? 'CALM',
        signals: d.content.signals ?? [],
        basis: d.fingerprint,
        windowStart: d.windowStart.toISOString(),
        windowEnd: d.windowEnd.toISOString(),
        generatedAt: now.toISOString(),
        coverage: 'CONNECTED_PARTIAL',
        limitations: [
          ...(d.content.limitations ?? []),
          'Read from bounded stored records for the displayed window. This does not prove current upstream synchronization or complete source coverage.',
        ],
      };
    } catch {
      return null;
    } // Existing coverage gaps remain; one unavailable source must not hide all others.
  }

  private async mail(
    principal: AiPrincipal,
    now: Date,
    options: ChatSourceOptions,
  ): Promise<BriefingArtifact[]> {
    const permitted = async () =>
      mailContentGovernance(this.ports.governanceDecision).state === 'DECIDED' &&
      !!(await this.prisma.sourceContentAuthorization.findFirst({
        where: { ...principal, provider: 'GMAIL', revokedAt: null },
        select: { id: true },
      }));
    if (!this.ports.readMailThread || !(await permitted())) return [];
    const rows = await this.prisma.workThread.findMany({
      where: {
        ...principal,
        // WorkThread stores the connection provider; content authorization above uses GMAIL.
        provider: 'GOOGLE',
        lastMessageAt: { gte: options.since, lt: options.until },
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'asc' }],
      take: 4,
      select: { id: true },
    });
    const artifacts: BriefingArtifact[] = [];
    for (const row of rows.slice(0, 3)) {
      if (options.signal?.aborted) break;
      if (!(await permitted()) || options.signal?.aborted) break;
      const thread = await this.ports.readMailThread(principal, row.id).catch(() => null);
      if (!thread || options.signal?.aborted) continue;
      artifacts.push({
        ref: `mail-thread:${row.id}`,
        domain: 'MAIL',
        title: thread.subject?.slice(0, 160) ?? 'Mail conversation',
        statement: JSON.stringify({
          subject: thread.subject?.slice(0, 300),
          messages: thread.messages.slice(-3).map((m) => ({ ...m, text: m.text.slice(0, 1000) })),
        }),
        status: 'WATCH',
        signals: [],
        basis: `mail-read:${now.toISOString()}`,
        generatedAt: now.toISOString(),
        windowStart: options.since.toISOString(),
        windowEnd: options.until.toISOString(),
        coverage: 'CONNECTED_PARTIAL',
        limitations: [
          'Selected recent conversations only, at most three threads and three trimmed messages per thread. This is not a complete inbox review or a saved importance flag. Messages may include automation; decide the appropriate action from their content.',
        ],
      });
    }
    return (await permitted()) ? artifacts : [];
  }
}
