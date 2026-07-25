// StateChangePublisher — drains the transactional outbox and dispatches each
// state change to its internal subscribers (Increment 3).
//
// This is the second half of the transactional-outbox pattern: the processor
// (Increment 2) commits a state change and its outbox row in ONE transaction;
// this publisher later drains those rows and fans each out to the ACTIVE
// subscriptions that match it. It is the ONLY I/O orchestrator here — the
// subscribers it calls read governed context through CognitiveContextService and
// record decisions/audit, but never execute an external action.
//
// Guarantees, all built on the database row as the mutex (no in-memory locks, no
// raw SQL):
//   - EXACTLY-ONCE per (change, subscriber): one StateChangeDelivery per
//     (outboxId, subscriptionId) (unique), claimed atomically PENDING/FAILED →
//     PROCESSING. Re-running the publisher — even concurrently — never
//     double-dispatches a succeeded delivery.
//   - INDEPENDENT retry / dead-letter per subscriber: a failing optional
//     subscriber retries with back-off and dead-letters on its own without
//     blocking siblings or the parent. A REQUIRED subscriber that dead-letters
//     fails the parent publication.
//   - ORDERED drain: rows are examined oldest-first (createdAt asc); a claimed
//     parent stays PROCESSING and is revisited each pass until every matched
//     delivery is terminal, so a slow retry never strands the row.
//
// Tenancy: organizationId is the first argument to run() and to every repository
// call, always from trusted server context — never from an outbox payload.

import type { PrismaClient, StateChangeOutbox, StateChangeSubscription } from '@prisma/client';

import {
  createCognitiveRepositories,
  type CognitiveRepositories,
} from '../../repositories/cognitive';
import { AuditRepository } from '../../repositories/audit.repository';
import { CognitiveContextService } from './context-service';
import {
  resolveSubscriber,
  type SubscriberDeps,
} from './subscribers';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_BATCH_SIZE = 100;

export interface PublisherOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  batchSize?: number;
}

export interface PublisherDeps {
  repos?: CognitiveRepositories;
  contextService?: CognitiveContextService;
  audit?: Pick<AuditRepository, 'record'>;
}

export interface PublishResult {
  /** Active outbox rows examined this pass (PENDING due + in-flight PROCESSING). */
  outboxSeen: number;
  /** Rows whose deliveries are all terminal → marked PUBLISHED this pass. */
  outboxPublished: number;
  /** Rows failed because a REQUIRED subscriber dead-lettered. */
  outboxDeadLettered: number;
  /** Rows still PROCESSING (some delivery retrying / not yet due). */
  outboxInFlight: number;
  /** Rows another worker owned this pass (lost the PENDING → PROCESSING claim). */
  outboxContended: number;
  deliveriesDispatched: number;
  deliveriesSucceeded: number;
  deliveriesFailed: number;
  deliveriesDeadLettered: number;
}

function emptyResult(): PublishResult {
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
  };
}

/** Stable per-change key for delivery idempotency: the revision, else the row id. */
function revisionKey(outbox: StateChangeOutbox): string {
  return outbox.activeStateRevisionId ?? outbox.id;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'unknown error';
}

export class StateChangePublisher {
  private readonly repos: CognitiveRepositories;
  private readonly contextService: CognitiveContextService;
  private readonly audit: Pick<AuditRepository, 'record'>;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly batchSize: number;

  constructor(prisma: PrismaClient, opts: PublisherOptions = {}, deps: PublisherDeps = {}) {
    this.repos = deps.repos ?? createCognitiveRepositories(prisma);
    this.contextService = deps.contextService ?? new CognitiveContextService(prisma, this.repos);
    this.audit = deps.audit ?? new AuditRepository(prisma);
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /**
   * Drain one publish pass for a single organization. Idempotent and safe to run
   * repeatedly (and concurrently): a fully-published change is a no-op, and an
   * in-flight change advances only its due, non-terminal deliveries.
   */
  async run(
    organizationId: string,
    opts: { now?: Date; take?: number } = {},
  ): Promise<PublishResult> {
    if (!organizationId) {
      throw new Error('StateChangePublisher.run: organizationId is required (server-derived, never client)');
    }
    const now = opts.now ?? new Date();
    const result = emptyResult();

    const rows = await this.repos.stateChangeOutbox.listActiveForPublish(organizationId, {
      take: opts.take ?? this.batchSize,
      now,
    });
    result.outboxSeen = rows.length;

    for (const outbox of rows) {
      await this.publishOne(organizationId, outbox, now, result);
    }
    return result;
  }

  private async publishOne(
    org: string,
    outbox: StateChangeOutbox,
    now: Date,
    result: PublishResult,
  ): Promise<void> {
    // Claim a newly-ready row. If another worker won the PENDING → PROCESSING
    // claim, leave it to them this pass. In-flight PROCESSING rows are already
    // ours to reconcile and skip this gate.
    if (outbox.status === 'PENDING') {
      const won = await this.repos.stateChangeOutbox.markProcessing(org, outbox.id);
      if (!won) {
        result.outboxContended += 1;
        return;
      }
    }

    // Fan out to every ACTIVE subscription matching this change's domain +
    // stateKey. ensure() is create-or-get, so re-running never duplicates.
    const subscriptions = await this.repos.subscriptions.findMatching(org, {
      domain: outbox.domain,
      stateKey: outbox.stateKey,
    });

    const subById = new Map<string, StateChangeSubscription>();
    for (const sub of subscriptions) {
      subById.set(sub.id, sub);
      await this.repos.stateChangeDeliveries.ensure(org, {
        outboxId: outbox.id,
        subscriptionId: sub.id,
        subscriberKey: sub.endpointOrHandler,
        idempotencyKey: `${revisionKey(outbox)}:${sub.id}`,
        required: sub.required,
        now,
      });
    }

    // Dispatch each due, non-terminal delivery. claim() is the single-claim gate:
    // a SUCCEEDED/DEAD_LETTERED or not-yet-due row returns false and is skipped.
    const deliveries = await this.repos.stateChangeDeliveries.listForOutbox(org, outbox.id);
    const deps: SubscriberDeps = {
      contextService: this.contextService,
      decisions: this.repos.decisions,
      audit: this.audit,
    };

    for (const delivery of deliveries) {
      const won = await this.repos.stateChangeDeliveries.claim(org, delivery.id, { now });
      if (!won) continue;
      result.deliveriesDispatched += 1;

      const subscription = subById.get(delivery.subscriptionId);
      const handler = subscription
        ? resolveSubscriber(subscription.endpointOrHandler)
        : undefined;

      if (!subscription || !handler) {
        // Unresolvable subscriber (deactivated subscription or unknown handler
        // key). Fail closed — retry then dead-letter; never silently succeed.
        const reason = !subscription
          ? 'subscription is no longer active'
          : `no internal handler registered for '${subscription.endpointOrHandler}'`;
        const failed = await this.repos.stateChangeDeliveries.markFailed(org, delivery.id, reason, {
          maxAttempts: this.maxAttempts,
          retryDelayMs: this.retryDelayMs,
          now,
        });
        if (failed?.status === 'DEAD_LETTERED') result.deliveriesDeadLettered += 1;
        else result.deliveriesFailed += 1;
        continue;
      }

      // Re-read the claimed row so the handler sees accurate delivery state.
      const claimed =
        (await this.repos.stateChangeDeliveries.findByPair(org, outbox.id, delivery.subscriptionId)) ??
        delivery;

      try {
        const outcome = await handler(
          { organizationId: org, outbox, subscription, delivery: claimed, now },
          deps,
        );
        await this.repos.stateChangeDeliveries.markSucceeded(org, delivery.id, {
          summary: outcome.summary,
          now,
        });
        result.deliveriesSucceeded += 1;
      } catch (e) {
        const failed = await this.repos.stateChangeDeliveries.markFailed(
          org,
          delivery.id,
          errorMessage(e),
          { maxAttempts: this.maxAttempts, retryDelayMs: this.retryDelayMs, now },
        );
        if (failed?.status === 'DEAD_LETTERED') result.deliveriesDeadLettered += 1;
        else result.deliveriesFailed += 1;
      }
    }

    await this.reconcileParent(org, outbox.id, result);
  }

  /**
   * Conclude (or keep in-flight) the parent outbox row from its deliveries:
   *   - any REQUIRED delivery dead-lettered → parent DEAD_LETTERED (fail closed);
   *   - all deliveries terminal (SUCCEEDED, or DEAD_LETTERED for OPTIONAL ones,
   *     or none matched at all) → parent PUBLISHED;
   *   - otherwise leave PROCESSING for a later pass (a delivery is still retrying
   *     or not yet due).
   */
  private async reconcileParent(org: string, outboxId: string, result: PublishResult): Promise<void> {
    const deliveries = await this.repos.stateChangeDeliveries.listForOutbox(org, outboxId);

    const requiredDead = deliveries.filter((d) => d.required && d.status === 'DEAD_LETTERED');
    if (requiredDead.length > 0) {
      const keys = requiredDead.map((d) => d.subscriberKey).join(', ');
      await this.repos.stateChangeOutbox.markDeadLettered(
        org,
        outboxId,
        `required subscriber(s) dead-lettered: ${keys}`,
      );
      result.outboxDeadLettered += 1;
      return;
    }

    const allTerminal = deliveries.every(
      (d) => d.status === 'SUCCEEDED' || d.status === 'DEAD_LETTERED',
    );
    if (allTerminal) {
      await this.repos.stateChangeOutbox.markPublished(org, outboxId);
      result.outboxPublished += 1;
    } else {
      result.outboxInFlight += 1;
    }
  }
}
