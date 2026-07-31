// OutboxDrainRunner — the one entry point that turns "there is work" into "the
// work ran", for every organization.
//
// WHY THIS EXISTS SEPARATELY FROM THE PUBLISHER. `StateChangePublisher.run()`
// drains ONE organization and knows nothing about scheduling. Something has to
// decide which organizations have work and bound how much runs in one go. Putting
// that in the publisher would tie delivery semantics to a schedule; putting it in
// a route handler would tie it to HTTP, and the second trigger would copy the
// handler.
//
// SO THE TRIGGER IS REPLACEABLE BY CONSTRUCTION. Everything about *what* a drain
// pass is lives here. Everything about *what woke it up* lives in the caller.
// Today the caller is a guarded route hit by a scheduled workflow. Tomorrow it
// can be a queue worker, a Lambda, a cron job, a CLI, or an admin button — none
// of which require a line of change here, and none of which the Decision Engine
// or the publisher ever learns about.
//
// It is deliberately NOT called a decision runner. Loop has ONE outbox for every
// subject — active state was first, decisions are second, the next is a
// `subjectType` value. A `DecisionOutboxRunner` would imply a per-subject drain
// and invite a second one, which is exactly how this repo acquired three workflow
// systems.
//
// BOUNDED ON PURPOSE. A drain triggered on a schedule must finish before the next
// tick and inside the caller's execution limit, so a pass stops at a deadline and
// at an organization cap rather than running until the queue is empty. Whatever
// is left is picked up by the next pass — that is what makes the trigger cheap to
// replace.

import type { PrismaClient } from '@prisma/client';

import { StateChangePublisher, type PublishResult, type PublisherOptions } from './state-change-publisher';
import { StateChangeOutboxRepository } from '../../repositories/cognitive/active-state.repository';

/** The default ceiling on a single pass. Well inside a serverless request. */
const DEFAULT_DEADLINE_MS = 25_000;
const DEFAULT_MAX_ORGANIZATIONS = 25;

export interface OutboxDrainOptions extends PublisherOptions {
  /** Stop starting new organizations after this long. Default 25s. */
  deadlineMs?: number;
  /** Never touch more than this many organizations in one pass. Default 25. */
  maxOrganizations?: number;
  /** Outbox rows per organization per pass. */
  take?: number;
  now?: Date;
}

export interface OrganizationDrainResult {
  organizationId: string;
  result: PublishResult | null;
  /** Present when this organization's pass threw. Others still ran. */
  error: string | null;
}

export interface OutboxDrainResult {
  /** Organizations found with work waiting. */
  organizationsWithWork: number;
  /** Organizations actually drained this pass. */
  organizationsDrained: number;
  /**
   * True when the pass stopped early at the deadline or the cap. NOT an error —
   * but if it is always true, the schedule is running behind the work.
   */
  truncated: boolean;
  /** Per-organization detail, so a failure names its tenant. */
  organizations: OrganizationDrainResult[];
  totals: PublishResult;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

function zeroTotals(): PublishResult {
  return {
    outboxSeen: 0,
    outboxPublished: 0,
    outboxDeadLettered: 0,
    outboxInFlight: 0,
    outboxContended: 0,
    deliveriesDispatched: 0,
    deliveriesSucceeded: 0,
    deliveriesFailed: 0,
    deliveriesDeadLettered: 0,
    deliveriesReclaimed: 0,
  };
}

function add(into: PublishResult, from: PublishResult): void {
  for (const key of Object.keys(into) as (keyof PublishResult)[]) {
    into[key] += from[key];
  }
}

export class OutboxDrainRunner {
  private readonly outbox: StateChangeOutboxRepository;
  private readonly publisher: StateChangePublisher;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly opts: OutboxDrainOptions = {},
    deps: { publisher?: StateChangePublisher; outbox?: StateChangeOutboxRepository } = {},
  ) {
    this.outbox = deps.outbox ?? new StateChangeOutboxRepository(prisma);
    this.publisher = deps.publisher ?? new StateChangePublisher(prisma, opts);
  }

  /**
   * Run one drain pass across every organization with work waiting.
   *
   * Safe to run concurrently with itself: every mutation underneath is a
   * conditional update on a database row, so two overlapping passes contend
   * rather than duplicate. A slow schedule and an impatient operator pressing a
   * button cannot corrupt each other.
   *
   * ONE ORGANIZATION'S FAILURE NEVER STOPS THE OTHERS. A throw is recorded
   * against that organization and the pass continues, because a single tenant's
   * bad row must not become a platform-wide delivery outage.
   */
  async run(): Promise<OutboxDrainResult> {
    const now = this.opts.now ?? new Date();
    const startedMs = now.getTime();
    const deadlineMs = this.opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const maxOrganizations = this.opts.maxOrganizations ?? DEFAULT_MAX_ORGANIZATIONS;

    // Server-derived, always. There is no request, no session and no caller-named
    // organization anywhere in this path — see the repository method's note on
    // why a background worker is not the tenancy hazard the rule guards against.
    const organizationIds = await this.outbox.listOrganizationIdsWithPendingWork({ now });

    const organizations: OrganizationDrainResult[] = [];
    const totals = zeroTotals();
    let truncated = false;

    for (const organizationId of organizationIds) {
      if (organizations.length >= maxOrganizations) {
        truncated = true;
        break;
      }
      // Checked BEFORE starting an organization, never mid-way: abandoning a
      // pass part-done is what strands deliveries, and the reclaim above exists
      // precisely because that used to be unrecoverable.
      if (Date.now() - startedMs >= deadlineMs) {
        truncated = true;
        break;
      }

      try {
        const result = await this.publisher.run(organizationId, {
          now: this.opts.now,
          take: this.opts.take,
        });
        add(totals, result);
        organizations.push({ organizationId, result, error: null });
      } catch (e) {
        organizations.push({
          organizationId,
          result: null,
          error: e instanceof Error ? e.message : 'unknown error',
        });
      }
    }

    const finished = new Date();
    return {
      organizationsWithWork: organizationIds.length,
      organizationsDrained: organizations.length,
      truncated: truncated || organizationIds.length > organizations.length,
      organizations,
      totals,
      startedAt: now.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - startedMs,
    };
  }
}

export function createOutboxDrainRunner(
  prisma: PrismaClient,
  opts: OutboxDrainOptions = {},
): OutboxDrainRunner {
  return new OutboxDrainRunner(prisma, opts);
}
