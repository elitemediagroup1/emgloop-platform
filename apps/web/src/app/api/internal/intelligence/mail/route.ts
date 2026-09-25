// The scheduled Mail intelligence pass (Loop Intelligence Phase E, 2026-09-26): the ONE host of the Mail
// producers (mail.thread@1, mail.domain@1), because they need what only this server holds -- each
// person's governed Gmail read-through and the web's governed AI gateway.
//
// FOUR GATES, EVERY ONE CLOSED TODAY:
//   1. INTELLIGENCE_MAIL_SECRET authenticates the scheduler (a class of caller, never a tenant);
//      missing is unauthorized, not open.
//   2. LOOP_INTELLIGENCE_MAIL_PRODUCERS must name the producer; unset, the pass is a no-op.
//   3. The counterparty-consent governance decision (LOOP_MAIL_CONTENT_GOVERNANCE_DECISION) must be
//      recorded; it is UNRESOLVED, so discovery finds nobody and every gather refuses.
//   4. Each person's own MAIL content authorization, re-checked at gather AND at the digest write; and
//      the mail tasks must be activated in the AI runtime with a provider policy for COMMUNICATION_CONTENT.
//
// No organization and no person is taken from the request. The producers discover the people who
// authorized their own mail; each thread is read as its owner, transiently, and only the reading is kept.
// The response is counts only.

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import {
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
    },
  });
  const report = await runIntelligencePass(
    {
      registry: new IntelligenceProducerRegistry(producers, active),
      queue: new IntelligenceRefreshQueueRepository(prisma),
      digests: new IntelligenceDigestRepository(prisma),
      leaseOwner: 'web:mail-intelligence',
      now,
    },
    // Bounded under the platform's request limit; what does not fit waits for the next pass.
    { limit: 10, leaseMs: 2 * 60 * 1000, maxAttempts: 4, discoverLimit: 200 },
  );
  return NextResponse.json({ ok: true, active: report.activeProducers, discovered: report.discovered, enqueued: report.enqueued, refused: report.refused, cycle: report.cycle });
}
