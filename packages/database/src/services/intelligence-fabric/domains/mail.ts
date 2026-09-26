// Mail intelligence producers (Loop Intelligence Phase D, 2026-09-26). BUILT, NOT COMMISSIONED.
//
//   mail.thread@1   ONE mail thread of a person's own mailbox -> their private MAIL THREAD digest. MODEL:
//                   the conversation-triage contract over the thread, read through the governed Gmail
//                   read-through (handed in as a port; bodies are transient). Only when the counterparty-
//                   consent governance decision is recorded (UNRESOLVED today), the person's own MAIL
//                   content authorization is in force (re-checked again inside the write), the task is
//                   activated, and this producer is activated. Obligations become typed signals of the
//                   reading; the deterministic mail lanes keep raising the correctable items.
//   mail.domain@1   The person's whole mailbox -> their private MAIL DOMAIN digest (the domain kit):
//                   MEASURED lane counts from Loop's own work items, the most pressing thread readings,
//                   and -- when mail.domain.reading is activated -- a model reading of those readings
//                   (never of the mail itself). Same gates.
//
// PRIVATE, ALWAYS. Every read is the principal's own (organization AND user); the digests are PRINCIPAL,
// provider GMAIL, basis CONTENT_AUTHORIZATION, so a revoke or an offboarding deletes them in that
// transaction. No raw body is persisted anywhere.

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  AI_TASK_MAIL_DOMAIN_READING,
  MAIL_CONTENT_TRIAGE_SCHEMA_ID,
  entityRefRefusal,
  mailContentGovernance,
  type AiContextItem,
  type IntelligenceSignal,
  type MailContentGovernance,
} from '@emgloop/shared';

import { IntelligenceDigestRepository, type IntelligenceDigestInput } from '../../../repositories/intelligence/intelligence-digest.repository';
import type { IntelligenceRefreshTarget } from '../../../repositories/intelligence/intelligence-refresh-queue.repository';
import type { MailContentTriageService } from '../../ai-runtime/mail-content-triage.service';
import type { MailTriageMessage } from '../../ai-runtime/mail-content-triage-context';
import { conversationDigestContent } from '../conversation-digest';
import { domainProducer, type DomainKitPorts, type RuleReading } from '../domain-kit';
import type { IntelligenceProducer } from '../producer';

export interface MailThreadRead {
  readonly subject: string | null;
  readonly messages: readonly MailTriageMessage[];
  readonly truncated: boolean;
}

export interface MailProducerPorts {
  readonly prisma: PrismaClient;
  /** The deployment's recorded governance decision (LOOP_MAIL_CONTENT_GOVERNANCE_DECISION), passed in. */
  readonly governanceDecision: string | null;
  /** The governed Gmail read-through: the person's OWN thread, bodies transient. Null when unreadable. */
  readonly readThread: (principal: { organizationId: string; userId: string }, loopThreadId: string) => Promise<MailThreadRead | null>;
  readonly triage: Pick<MailContentTriageService, 'triage'> | null;
  readonly modelEnabled: (taskId: string) => boolean;
  readonly now: () => Date;
}

const RECENT_DAYS = 14;
const THREADS_PER_PERSON = 25;
const DAY = 24 * 60 * 60 * 1000;

interface ThreadContext {
  readonly principal: { readonly organizationId: string; readonly userId: string };
  readonly threadId: string;
  readonly subject: string | null;
  readonly lastMessageAt: Date | null;
}

/** The gates every Mail content producer checks, from Loop's own records. */
async function mailGate(prisma: PrismaClient, governance: MailContentGovernance, principal: { organizationId: string; userId: string }): Promise<string | null> {
  if (governance.state !== 'DECIDED') return 'GOVERNANCE_UNDECIDED';
  const auth = await prisma.sourceContentAuthorization.findFirst({ where: { ...principal, provider: 'GMAIL', revokedAt: null }, select: { id: true } });
  return auth ? null : 'CONTENT_NOT_AUTHORIZED';
}

async function authorizedPeople(prisma: PrismaClient): Promise<{ organizationId: string; userId: string }[]> {
  return prisma.sourceContentAuthorization.findMany({ where: { provider: 'GMAIL', revokedAt: null }, select: { organizationId: true, userId: true }, take: 500 });
}

export function mailThreadProducer(ports: MailProducerPorts): IntelligenceProducer<ThreadContext> {
  const governance = mailContentGovernance(ports.governanceDecision);
  return {
    id: 'mail.thread@1',
    domain: 'MAIL',
    scope: 'PRINCIPAL',
    subjectKinds: ['THREAD'],
    kind: 'MODEL',
    taskId: 'mail.content.triage',
    async discover(now) {
      if (governance.state !== 'DECIDED') return [];
      const out: IntelligenceRefreshTarget[] = [];
      for (const p of await authorizedPeople(ports.prisma)) {
        const threads = await ports.prisma.workThread.findMany({
          where: { ...p, lastMessageAt: { gte: new Date(now.getTime() - RECENT_DAYS * DAY) } },
          orderBy: { lastMessageAt: 'desc' },
          take: THREADS_PER_PERSON,
          select: { id: true },
        });
        for (const t of threads) out.push({ scope: 'PRINCIPAL', organizationId: p.organizationId, userId: p.userId, domain: 'MAIL', subjectKind: 'THREAD', subjectRef: `work_thread:${t.id}` });
      }
      return out;
    },
    async gather(target) {
      if (target.scope !== 'PRINCIPAL') return { status: 'NOT_PERMITTED', reason: 'PRINCIPAL_ONLY' };
      const principal = { organizationId: target.organizationId, userId: target.userId };
      const refused = await mailGate(ports.prisma, governance, principal);
      if (refused) return { status: 'NOT_PERMITTED', reason: refused };
      const id = target.subjectRef.startsWith('work_thread:') ? target.subjectRef.slice('work_thread:'.length) : '';
      if (!id) return { status: 'NOT_PERMITTED', reason: 'BAD_SUBJECT' };
      const thread = await ports.prisma.workThread.findFirst({ where: { id, ...principal }, select: { id: true, subject: true, lastMessageAt: true, lastMessageId: true, messageCount: true } });
      if (!thread || thread.messageCount === 0) return { status: 'NO_EVIDENCE' };
      // The fingerprint is Loop's stored metadata only: an unchanged thread costs no Gmail read and no call.
      const fingerprint = `mail:${createHash('sha256').update([MAIL_CONTENT_TRIAGE_SCHEMA_ID, thread.id, thread.lastMessageId ?? '', thread.messageCount].join('\n')).digest('hex')}`;
      return { status: 'READY', fingerprint, context: { principal, threadId: thread.id, subject: thread.subject, lastMessageAt: thread.lastMessageAt } };
    },
    async read(_target, ctx, fingerprint, now) {
      if (!ports.triage || !ports.modelEnabled('mail.content.triage')) return { status: 'NOT_READ', reason: 'AI_NOT_ACTIVATED', retryable: false };
      const thread = await ports.readThread(ctx.principal, ctx.threadId);
      if (!thread || thread.messages.length === 0) return { status: 'NOT_READ', reason: 'SOURCE_UNAVAILABLE', retryable: true };
      const answer = await ports.triage.triage(ctx.principal, { threadId: ctx.threadId, subject: thread.subject, messages: thread.messages, truncated: thread.truncated, lane: null });
      if (answer.outcome === 'NOT_AVAILABLE') return { status: 'NOT_READ', reason: 'AI_NOT_AVAILABLE', retryable: false };
      if (answer.outcome !== 'TRIAGED') return { status: 'NOT_READ', reason: answer.outcome, retryable: answer.outcome === 'FAILED' };
      // An obligation the items list carries and the reading does not is kept as an OBLIGATION signal.
      const reading = answer.reading
        ? {
            ...answer.reading,
            signals: [
              ...answer.reading.signals,
              ...answer.obligations
                .filter((o) => !answer.reading!.signals.some((s) => s.kind === 'OBLIGATION' && s.anchorRef === o.anchorRef))
                .map((o) => ({ kind: 'OBLIGATION', anchorRef: o.anchorRef, statement: o.statement.slice(0, 140), severity: 'MEDIUM' as const, owedBy: o.owedBy, who: o.who })),
            ].slice(0, 12),
          }
        : null;
      const ref = `work_thread:${ctx.threadId}`;
      const dates = thread.messages.map((m) => m.occurredAt.getTime());
      const { content, anchors } = conversationDigestContent(reading, answer.limitations, {
        evidenceRef: (r) => r,
        occurredAt: (r) => {
          const n = Number(r.split(':').pop());
          return Number.isInteger(n) && thread.messages[n - 1] ? thread.messages[n - 1]!.occurredAt : null;
        },
        label: thread.subject,
        kind: null,
        entityRefs: entityRefRefusal(ref, 'PRINCIPAL') === null ? [ref] : [],
      });
      const newest = new Date(Math.max(...dates));
      const coverage = reading === null ? 'CONNECTED_INSUFFICIENT' : thread.truncated ? 'CONNECTED_PARTIAL' : 'CONNECTED_SUFFICIENT';
      const digest: IntelligenceDigestInput = {
        domain: 'MAIL',
        subjectKind: 'THREAD',
        subjectRef: ref,
        provider: 'GMAIL',
        consentBasis: 'CONTENT_AUTHORIZATION',
        content,
        coverage,
        windowStart: new Date(Math.min(...dates)),
        windowEnd: newest,
        evidenceCount: thread.messages.length,
        lastEvidenceAt: newest,
        provenance: {
          sourceRefs: [ref],
          anchorEventIds: [...anchors],
          aiInvocationId: answer.provenance.invocationId,
          taskId: answer.provenance.taskId,
          taskVersion: answer.provenance.taskVersion,
          schemaId: MAIL_CONTENT_TRIAGE_SCHEMA_ID,
          producerVersion: 'mail.thread@1',
          producerKind: 'MODEL',
          sources: [{ sourceId: 'GMAIL', asOf: newest.toISOString(), coverage }],
        },
        aiInvocationId: answer.provenance.invocationId,
        entityRefs: entityRefRefusal(ref, 'PRINCIPAL') === null ? [ref] : [],
        fingerprint,
        generatedAt: now,
      };
      return { status: 'READ', digest };
    },
  };
}

interface MailDomainContext {
  readonly principal: { readonly organizationId: string; readonly userId: string };
  readonly lanes: { readonly needsYou: number; readonly waiting: number; readonly quiet: number };
  readonly threads: readonly { readonly ref: string; readonly label: string | null; readonly statement: string | null; readonly signals: readonly IntelligenceSignal[]; readonly lastEvidenceAt: Date | null }[];
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

const LANE_CLASSES = { needsYou: 'NEEDS_YOU', waiting: 'WAITING_ON_THEM', quiet: 'GONE_QUIET' } as const;

export function mailDomainProducer(ports: MailProducerPorts, kit: DomainKitPorts): IntelligenceProducer<MailDomainContext> {
  const governance = mailContentGovernance(ports.governanceDecision);
  return domainProducer<MailDomainContext>(
    {
      id: 'mail.domain@1',
      domain: 'MAIL',
      scope: 'PRINCIPAL',
      version: '1',
      provider: 'GMAIL',
      consentBasis: 'CONTENT_AUTHORIZATION',
      async discover() {
        if (governance.state !== 'DECIDED') return [];
        return (await authorizedPeople(ports.prisma)).map((p) => ({ scope: 'PRINCIPAL', organizationId: p.organizationId, userId: p.userId, domain: 'MAIL', subjectKind: 'DOMAIN', subjectRef: 'domain' }) as const);
      },
      async gather(target, now) {
        if (target.scope !== 'PRINCIPAL') return { status: 'NOT_PERMITTED', reason: 'PRINCIPAL_ONLY' };
        const principal = { organizationId: target.organizationId, userId: target.userId };
        const refused = await mailGate(ports.prisma, governance, principal);
        if (refused) return { status: 'NOT_PERMITTED', reason: refused };
        const [grouped, digests] = await Promise.all([
          ports.prisma.workItem.groupBy({ by: ['class'], where: { ...principal, state: 'OPEN', subjectKind: 'THREAD', producerKind: 'RULE' }, _count: { _all: true } }),
          new IntelligenceDigestRepository(ports.prisma).forDomain(principal, 'MAIL', { now, limit: 50 }),
        ]);
        const count = (cls: string) => grouped.find((g) => g.class === cls)?._count._all ?? 0;
        const threads = digests
          .filter((d) => d.subjectKind === 'THREAD' && d.status === 'CURRENT')
          .map((d) => ({ ref: d.subjectRef, label: d.content.label ?? null, statement: d.content.reading?.statement ?? d.content.synthesis ?? null, signals: d.content.signals ?? [], lastEvidenceAt: d.lastEvidenceAt, fp: d.fingerprint }));
        const lanes = { needsYou: count(LANE_CLASSES.needsYou), waiting: count(LANE_CLASSES.waiting), quiet: count(LANE_CLASSES.quiet) };
        if (threads.length === 0 && lanes.needsYou + lanes.waiting + lanes.quiet === 0) return { status: 'NO_EVIDENCE' };
        const fingerprint = `mail-domain:${createHash('sha256').update(JSON.stringify([lanes, threads.map((t) => t.fp)])).digest('hex')}`;
        const instants = threads.map((t) => t.lastEvidenceAt?.getTime() ?? now.getTime());
        return {
          status: 'READY',
          fingerprint,
          context: {
            principal,
            lanes,
            threads: threads.map(({ fp: _f, ...t }) => t),
            windowStart: new Date(Math.min(now.getTime() - RECENT_DAYS * DAY, ...instants)),
            windowEnd: now,
          },
        };
      },
      rule(ctx, now): RuleReading {
        const measured = (key: string, kind: IntelligenceSignal['kind'], statement: string, value: number): IntelligenceSignal => ({
          key,
          kind,
          knowledge: 'MEASURED',
          statement,
          evidenceRefs: ['work_items:mail-lanes'],
          severity: value > 0 && kind === 'ATTENTION' ? 'HIGH' : 'LOW',
          metric: { name: key.replace(/-/g, '_'), value, unit: 'count' },
          asOf: now.toISOString(),
        });
        const signals: IntelligenceSignal[] = [];
        if (ctx.lanes.needsYou > 0) signals.push(measured('needs-reply', 'ATTENTION', `${ctx.lanes.needsYou} ${ctx.lanes.needsYou === 1 ? 'thread needs' : 'threads need'} your reply.`, ctx.lanes.needsYou));
        if (ctx.lanes.waiting > 0) signals.push(measured('waiting-on-others', 'OBLIGATION', `${ctx.lanes.waiting} ${ctx.lanes.waiting === 1 ? 'thread is' : 'threads are'} waiting on others.`, ctx.lanes.waiting));
        if (ctx.lanes.quiet > 0) signals.push(measured('gone-quiet', 'STALLED', `${ctx.lanes.quiet} ${ctx.lanes.quiet === 1 ? 'thread has' : 'threads have'} gone quiet.`, ctx.lanes.quiet));
        // The most pressing thread readings, their knowledge kept as it was read.
        const pressing = ctx.threads.flatMap((t) => t.signals.filter((s) => s.kind === 'OBLIGATION' || s.kind === 'DECISION_PENDING' || s.kind === 'RISK' || s.severity === 'HIGH').map((s) => ({ ...s, key: `t.${s.key}`.slice(0, 64) })));
        signals.push(...pressing.slice(0, 12 - signals.length));
        // The waiting-on-others count is an obligation someone ELSE holds: no owedBy is claimed for it.
        const fixed = signals.map((s) => (s.key === 'waiting-on-others' ? { ...s, kind: 'UNRESOLVED' as const } : s));
        const needs = ctx.lanes.needsYou;
        const statement =
          needs > 0
            ? `${needs} ${needs === 1 ? 'thread needs' : 'threads need'} your reply${ctx.lanes.waiting > 0 ? `, and ${ctx.lanes.waiting} ${ctx.lanes.waiting === 1 ? 'is' : 'are'} waiting on others` : ''}.`
            : ctx.threads.length > 0
              ? `Loop has a reading of ${ctx.threads.length} recent ${ctx.threads.length === 1 ? 'thread' : 'threads'}; none is waiting on you.`
              : 'Nothing in your mail is waiting on you.';
        return {
          statement,
          status: needs > 0 ? 'ATTENTION' : pressing.length > 0 ? 'WATCH' : 'CALM',
          confidence: 'HIGH',
          signals: fixed,
          limitations: [],
          entityRefs: ctx.threads.map((t) => t.ref).filter((r) => entityRefRefusal(r, 'PRINCIPAL') === null).slice(0, 32),
          coverage: 'CONNECTED_SUFFICIENT',
          windowStart: ctx.windowStart,
          windowEnd: ctx.windowEnd,
          evidenceCount: ctx.threads.length + ctx.lanes.needsYou + ctx.lanes.waiting + ctx.lanes.quiet,
          lastEvidenceAt: ctx.windowEnd,
          sources: [{ sourceId: 'GMAIL', asOf: ctx.windowEnd.toISOString(), coverage: 'CONNECTED_SUFFICIENT' }],
          sourceRefs: ['work_items:mail-lanes', ...ctx.threads.map((t) => t.ref)].slice(0, 64),
        };
      },
      model: {
        task: AI_TASK_MAIL_DOMAIN_READING,
        framing: {
          domainDescription: "one person's own mailbox (Loop's readings of their recent threads and their reply lanes)",
          audience: 'PRINCIPAL',
          lookFor: ['what they owe and to whom', 'who they are waiting on', 'threads that went quiet with something open', 'decisions pending, risks and opportunities across threads'],
        },
        context(ctx) {
          const items: AiContextItem[] = [];
          const read = { resource: 'employeeIntelligence', action: 'view' } as const;
          items.push({ blockId: 'mail-lanes', kind: 'STRUCTURED', trust: 'GOVERNED_FACT', sourceRef: 'work_items:mail-lanes', content: JSON.stringify(ctx.lanes), sensitivity: 'OPERATIONAL', readUnder: read });
          for (const t of ctx.threads.slice(0, 20)) {
            items.push({
              blockId: t.ref,
              kind: 'STRUCTURED',
              trust: 'GOVERNED_FACT',
              sourceRef: t.ref,
              content: JSON.stringify({ subject: t.label, reading: t.statement, signals: t.signals.map((s) => ({ kind: s.kind, statement: s.statement, owedBy: s.owedBy ?? null, party: s.party ?? null })) }),
              sensitivity: 'COMMUNICATION_CONTENT',
              readUnder: read,
            });
          }
          return {
            items,
            evidence: {
              figures: new Map([['work_items:mail-lanes', new Set([ctx.lanes.needsYou, ctx.lanes.waiting, ctx.lanes.quiet])]]),
              dates: new Set(),
              entityRefs: new Set(ctx.threads.map((t) => t.ref)),
            },
          };
        },
      },
    },
    kit,
  );
}
