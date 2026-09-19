// What runs when a source has been READ -- not when somebody opens a page.
//
// A completed read of Gmail, Calendar or CallGrid is the moment Loop has something new to think
// about. Until this existed, the detectors that turn stored facts into intelligence ran only on a
// page render: an employee's mail queue was recomputed when they opened Home or Mail, and a
// CallGrid situation was recorded when somebody opened a CallGrid page. Nobody looking meant
// nothing noticed.
//
// A DISPATCHER, NOT A SCHEDULER. The caller that completed the read -- the scheduled employee
// cycle today -- hands this one event. Every detector registered for that source runs once, in
// order, and reports counts. Nothing here decides when to run, loops, retries on its own or calls
// a provider: the read already happened, and a detector reads only what the read stored.
//
// BOUNDED, IDEMPOTENT, SCOPED, OBSERVABLE:
//   - bounded: one event is one principal (or one organization) and a fixed list of detectors,
//     each of which reads a capped slice of stored facts;
//   - idempotent: every detector writes through a keyed, append-only authority (work items by
//     recurrence key, Cases by detection key), so the same event twice changes nothing twice;
//   - scoped: a PRIVATE detector runs only for the person whose source was read, and is refused an
//     event without one; an ORGANIZATION detector never receives a person;
//   - observable: the result is detector ids and counts -- never a subject, an address or text.
//
// THINK, NEVER ACT. A detector may create or update INTERNAL intelligence (a work item, a Case, a
// Finding). It may not send, message, change a bid or campaign, commit money, verify an identity or
// do anything else outside Loop. That boundary is the detector contract below: its only outputs are
// counts, and the only dependencies it is built with are Loop's own repositories.
import type { PrismaClient } from '@prisma/client';
import { WorkGraphRepository } from '../../repositories/work-state/work-graph.repository';
import { WorkItemRepository } from '../../repositories/work-state/work-item.repository';
import { MailAttentionService, mailThreadFacts } from '../work-state/mail-attention.service';

export const READ_SOURCES = ['GMAIL', 'CALENDAR', 'CALLGRID'] as const;
export type ReadSourceKey = (typeof READ_SOURCES)[number];

/** A source read that completed. The only thing a detector is told. */
export interface SourceReadEvent {
  readonly organizationId: string;
  /** The person whose PRIVATE source was read; null for an organization source (CallGrid). */
  readonly userId: string | null;
  readonly source: ReadSourceKey;
  readonly completedAt: Date;
}

export interface SourceReadDetector {
  /** Stable id, for logs and tests. */
  readonly id: string;
  readonly sources: readonly ReadSourceKey[];
  /** PRIVATE: runs for one person's own source and writes only into their own scope. */
  readonly scope: 'PRIVATE' | 'ORGANIZATION';
  /** Counts only. A detector reports what it did, never what it saw. */
  detect(event: SourceReadEvent): Promise<Readonly<Record<string, number>>>;
}

export interface DetectorRun {
  readonly detector: string;
  readonly result: 'RAN' | 'REFUSED' | 'FAILED';
  readonly counts: Readonly<Record<string, number>>;
}

export class SourceReadDispatcher {
  constructor(private readonly detectors: readonly SourceReadDetector[]) {}

  /** Every detector registered for this source, once each. One failing never stops the next. */
  async dispatch(event: SourceReadEvent): Promise<readonly DetectorRun[]> {
    const runs: DetectorRun[] = [];
    for (const detector of this.detectors) {
      if (!detector.sources.includes(event.source)) continue;
      // Scope is checked before anything runs: a private detector with no person, or an
      // organization detector handed one, is a wiring mistake, and a refusal is its only safe answer.
      if ((detector.scope === 'PRIVATE') !== (event.userId !== null)) {
        runs.push({ detector: detector.id, result: 'REFUSED', counts: {} });
        continue;
      }
      try {
        runs.push({ detector: detector.id, result: 'RAN', counts: await detector.detect(event) });
      } catch {
        // The message is dropped: it is the one place stored content could reach a log.
        runs.push({ detector: detector.id, result: 'FAILED', counts: {} });
      }
    }
    return runs;
  }
}

/**
 * The employee's mail queue (GM-3), brought up to date from what the read just stored -- the same
 * service and the same facts a page visit uses, so a person's queue is the same whichever ran last.
 * Their corrections hold exactly as they do on a visit: a closed item reopens only on a message
 * that arrived after they closed it.
 */
export function mailAttentionDetector(prisma: PrismaClient): SourceReadDetector {
  return {
    id: 'mail-attention',
    sources: ['GMAIL'],
    scope: 'PRIVATE',
    async detect(event) {
      const principal = { organizationId: event.organizationId, userId: event.userId! };
      const facts = await mailThreadFacts(new WorkGraphRepository(prisma), principal);
      const outcome = await new MailAttentionService({ items: new WorkItemRepository(prisma), now: () => event.completedAt }).refresh(principal, facts);
      return { ...outcome };
    },
  };
}

/** The detectors that run after a read, in order. */
export function sourceReadDetectors(prisma: PrismaClient): SourceReadDetector[] {
  return [mailAttentionDetector(prisma)];
}
