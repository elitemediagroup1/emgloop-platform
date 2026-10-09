// The scheduled Mail intelligence pass (Loop Intelligence Phase E, 2026-09-26): the ONE host of the Mail
// producers (mail.thread@1, mail.domain@1), because they need what only this server holds -- each
// person's governed Gmail read-through and the web's governed AI gateway.
//
// FOUR GATES, ALL REQUIRED:
//   1. INTELLIGENCE_MAIL_SECRET authenticates the scheduler (a class of caller, never a tenant);
//      missing is unauthorized, not open.
//   2. LOOP_INTELLIGENCE_MAIL_PRODUCERS must name the producer; unset, the pass is a no-op.
//   3. LOOP_MAIL_CONTENT_GOVERNANCE_DECISION must equal the exact decision recorded in the repository;
//      any other value makes discovery empty and every gather refuse.
//   4. Each person's own MAIL content authorization, re-checked at gather AND at the digest write; and
//      the mail tasks must be activated in the AI runtime with a provider policy for COMMUNICATION_CONTENT.
//
// No organization and no person is taken from the request. The producers discover the people who
// authorized their own mail; each thread is read as its owner, transiently, and only the reading is kept.
// The response is counts only.

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import {
  CrmMailPriorityService,
  DomainReadingService,
  IntelligenceDigestRepository,
  IntelligenceProducerRegistry,
  IntelligenceRefreshQueueRepository,
  MailContentTriageService,
  gmailMailReadThrough,
  loopProducers,
  parseProducerActivation,
  prisma,
  repositories,
  runIntelligencePass,
} from '@emgloop/database';

import { governedGateway } from '../../../../../ai/governed-gateway';
import { GMAIL_CONFIG } from '../../../../../daily-loop/mail';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAIL_PRODUCERS = new Set(['mail.thread@1', 'mail.domain@1']);
const CRM_PROMOTION_LIMIT = 150;
const CRM_PROMOTION_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;
const CRM_PROMOTION_NOT_BEFORE = new Date(0);

async function promoteUncoveredCrmThreads(
  queue: IntelligenceRefreshQueueRepository,
  crmMailPriority: CrmMailPriorityService,
  at: Date,
): Promise<number> {
  const principals = await prisma.sourceContentAuthorization.findMany({
    where: { provider: 'GMAIL', revokedAt: null },
    select: { organizationId: true, userId: true },
    take: 500,
  });
  let promoted = 0;
  const since = new Date(at.getTime() - CRM_PROMOTION_WINDOW_MS);

  for (const principal of principals) {
    if (promoted >= CRM_PROMOTION_LIMIT) break;

    const providerThreadIds = await crmMailPriority.recentThreadIds(principal, {
      since,
      limit: CRM_PROMOTION_LIMIT - promoted,
    });
    if (providerThreadIds.length === 0) continue;

    const threads = await prisma.workThread.findMany({
      where: { ...principal, threadId: { in: providerThreadIds }, lastMessageAt: { gte: since } },
      select: { id: true },
      take: CRM_PROMOTION_LIMIT - promoted,
    });
    if (threads.length === 0) continue;

    const refs = threads.map((thread) => `work_thread:${thread.id}`);
    const current = await prisma.intelligenceDigest.findMany({
      where: {
        ...principal,
        scope: 'PRINCIPAL',
        domain: 'MAIL',
        subjectKind: 'THREAD',
        subjectRef: { in: refs },
        status: 'CURRENT',
        expiresAt: { gt: at },
      },
      select: { subjectRef: true },
    });
    const covered = new Set(current.map((row) => row.subjectRef));

    for (const thread of threads) {
      if (promoted >= CRM_PROMOTION_LIMIT) break;
      const subjectRef = `work_thread:${thread.id}`;
      if (covered.has(subjectRef)) continue;

      const outcome = await queue.enqueue(
        {
          scope: 'PRINCIPAL',
          organizationId: principal.organizationId,
          userId: principal.userId,
          domain: 'MAIL',
          subjectKind: 'THREAD',
          subjectRef,
        },
        {
          reason: 'SCHEDULED',
          // The queue orders due work by notBefore. Backdating ONLY CRM-linked threads that have no
          // current digest moves initial CRM coverage ahead of the legacy general-Mail backlog without
          // deleting or mutating that backlog. Once a digest exists, this promotion no longer applies.
          notBefore: CRM_PROMOTION_NOT_BEFORE,
        },
        at,
      );
      if (outcome.outcome !== 'REFUSED') promoted += 1;
    }
  }

  return promoted;
}

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.INTELLIGENCE_MAIL_SECRET;
  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!expected || !provided || !secretMatches(provided, expected)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  // Only Mail producers are hosted here; anything else named is ignored (the worker hosts the rest).
  const active = parseProducerActivation(process.env.LOOP_INTELLIGENCE_MAIL_PRODUCERS).filter((id) => MAIL_PRODUCERS.has(id));
  if (active.length === 0) return NextResponse.json({ ok: true, active: 0 });

  const { env, gateway } = governedGateway();
  const activated = env.activation.enabled ? env.activation.tasks : [];
  const now = () => new Date();
  const crmMailPriority = new CrmMailPriorityService(prisma);
  const queue = new IntelligenceRefreshQueueRepository(prisma);
  const promotionAt = now();
  const promoted = active.includes('mail.thread@1')
    ? await promoteUncoveredCrmThreads(queue, crmMailPriority, promotionAt)
    : 0;

  const producers = loopProducers({
    prisma,
    work: repositories.work,
    reader: new DomainReadingService(gateway),
    modelEnabled: (taskId) => activated.includes(taskId),
    actingUsers: new Map(),
    now,
    mail: {
      governanceDecision: process.env.LOOP_MAIL_CONTENT_GOVERNANCE_DECISION ?? null,
      readThread: gmailMailReadThrough(prisma, GMAIL_CONFIG()),
      triage: new MailContentTriageService(gateway),
      prioritizedThreadIds: (principal, since, limit) => crmMailPriority.recentThreadIds(principal, { since, limit }),
    },
  });
  const report = await runIntelligencePass(
    {
      registry: new IntelligenceProducerRegistry(producers, active),
      queue,
      digests: new IntelligenceDigestRepository(prisma),
      leaseOwner: 'web:mail-intelligence',
      now,
    },
    // Keep the model-backed Mail pass comfortably inside the production request window.
    // What does not fit remains queued for the next scheduled pass.
    { limit: 2, leaseMs: 2 * 60 * 1000, maxAttempts: 4, discoverLimit: 200 },
  );
  return NextResponse.json({ ok: true, active: report.activeProducers, promoted, discovered: report.discovered, enqueued: report.enqueued, refused: report.refused, cycle: report.cycle });
}
