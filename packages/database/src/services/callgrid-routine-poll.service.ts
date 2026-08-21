// Routine CallGrid polling — plan an interval, poll it, prove it, record it.
//
// THIS LAYER DECIDES TWO THINGS AND NOTHING ELSE:
//
//   WHAT to read next    from the durable checkpoint, through a pure planner
//   WHETHER it counted   from the poll outcome, through one named rule
//
// Everything between those two decisions belongs to `CallGridPollService.execute`
// and to the ingestion path beneath it. This file maps no record, follows no
// cursor, writes no MarketplaceCall, converges no fact and reconciles nothing --
// there are source-level assertions saying so, because a checkpoint layer that
// starts touching records is how a platform ends up with two ingestion engines.
//
// IT IS NOT A SCHEDULER. Nothing here has a timer, a cron expression or a
// concept of "every fifteen minutes". `run()` happens when something calls it,
// and today the only thing that calls it is a person. What this PR establishes is
// that when a scheduler does exist, the question "which interval?" already has a
// durable, provable answer instead of a guess.
//
// THE INVARIANT THAT SHAPES IT
//
//   CHECKPOINT ADVANCEMENT IS PROOF OF COVERAGE.
//
// The boundary moves only when the provider read COMPLETED and every accepted
// record was applied. A truncated read, an exhausted 429 budget, a pagination
// fault, a provider error, an unmappable record, a run that stopped halfway and
// a dry run all leave it exactly where it was. The cost of not advancing is that
// an interval gets read again, and re-reading is the cheap direction: identity is
// canonical, observation is idempotent and convergence never weakens a fact.

import type { PrismaClient } from '@prisma/client';
import { INTERVAL_MAX_SPAN_DAYS } from '@emgloop/providers';
import {
  DEFAULT_POLL_BOOTSTRAP_LOOKBACK_MS,
  DEFAULT_POLL_OVERLAP_MS,
  DEFAULT_POLL_SAFETY_LAG_MS,
  planPollInterval,
  type PollIntervalPlan,
  type PollIntervalPolicy,
} from '@emgloop/shared';

import {
  ProviderPollCheckpointRepository,
  type AdvanceOutcome,
} from '../repositories/provider-poll-checkpoint.repository';
import {
  CALLGRID_POLL_PROVIDER,
  CALLGRID_POLL_STREAM,
  CallGridPollService,
  checkpointMayAdvance,
  type CallGridPollExecution,
  type CallGridPollObserver,
} from './callgrid-poll.service';

/**
 * The policy this repository ships with.
 *
 * The span ceiling is TAKEN FROM THE READER rather than restated, so the planner
 * can never propose an interval the reader would refuse. The other three are
 * durations chosen here and labelled as policy in `poll-interval-planning.ts`.
 */
export const CALLGRID_POLL_POLICY: PollIntervalPolicy = {
  overlapMs: DEFAULT_POLL_OVERLAP_MS,
  bootstrapLookbackMs: DEFAULT_POLL_BOOTSTRAP_LOOKBACK_MS,
  safetyLagMs: DEFAULT_POLL_SAFETY_LAG_MS,
  maxSpanMs: INTERVAL_MAX_SPAN_DAYS * 24 * 60 * 60 * 1000,
};

export interface RoutinePollInput {
  organizationId: string;
  apiKey: string;
  /** Supplied, because this layer owns no clock either. */
  now: Date;
  apiBaseUrl?: string | undefined;
  providerConnectionId?: string | null;
  /**
   * A dry run reads and reports and writes nothing -- including the checkpoint.
   * Describing what a poll WOULD cover is not covering it.
   */
  dryRun?: boolean;
  /** Overridable so a test can state a policy explicitly. Production passes none. */
  policy?: PollIntervalPolicy;
}

export interface RoutinePollResult {
  /** The boundary coverage was proven through BEFORE this run. Null if never. */
  checkpointBefore: Date | null;
  /** The boundary now, whoever proved it. Null if still nothing is proven. */
  checkpointAfter: Date | null;
  plan: PollIntervalPlan;
  /** Absent when the plan read nothing. */
  execution: CallGridPollExecution | null;
  /**
   * Whether the checkpoint moved, and if not, why not. `NOT_PROVEN` is the
   * ordinary answer for every unsuccessful poll and is not an error.
   */
  advancement: AdvanceOutcome | 'NOT_PROVEN' | 'NOT_ATTEMPTED';
  /** One sentence for an operator. Never a credential. */
  reason: string;
}

export interface CallGridRoutinePollDeps {
  /** Injected so the advancement rule can be proved without a provider. */
  poller?: Pick<CallGridPollService, 'execute'>;
  checkpoints?: ProviderPollCheckpointRepository;
}

export class CallGridRoutinePollService {
  private readonly poller: Pick<CallGridPollService, 'execute'>;
  private readonly checkpoints: ProviderPollCheckpointRepository;

  constructor(prisma: PrismaClient, deps: CallGridRoutinePollDeps = {}) {
    this.poller = deps.poller ?? new CallGridPollService(prisma);
    this.checkpoints = deps.checkpoints ?? new ProviderPollCheckpointRepository(prisma);
  }

  /**
   * Read the next routine interval and advance the checkpoint only if it proved.
   *
   * THE ORDER IS LOAD-BEARING. Plan, poll, then record -- and the recording is a
   * separate statement from the thousands of ingestion writes before it, not part
   * of a transaction with them. Wrapping a provider day in one transaction to make
   * the checkpoint atomic with every record would hold a write transaction open
   * for the length of a provider read, and would buy nothing: the failure it
   * protects against (dying after the last record and before the checkpoint) is
   * already safe, because re-running the interval re-observes rows that exist
   * rather than duplicating them. Idempotent replay is the cheaper correctness.
   */
  async run(input: RoutinePollInput, observer?: CallGridPollObserver): Promise<RoutinePollResult> {
    const policy = input.policy ?? CALLGRID_POLL_POLICY;
    const stored = await this.checkpoints.find(
      input.organizationId,
      CALLGRID_POLL_PROVIDER,
      CALLGRID_POLL_STREAM,
    );
    const checkpointBefore = stored?.completedThrough ?? null;

    const plan = planPollInterval({ completedThrough: checkpointBefore, now: input.now, policy });
    if (plan.plan !== 'POLL') {
      return {
        checkpointBefore,
        checkpointAfter: checkpointBefore,
        plan,
        execution: null,
        advancement: 'NOT_ATTEMPTED',
        reason: plan.reason,
      };
    }

    const execution = await this.poller.execute(
      {
        organizationId: input.organizationId,
        apiKey: input.apiKey,
        since: plan.since,
        until: plan.until,
        apiBaseUrl: input.apiBaseUrl,
        providerConnectionId: input.providerConnectionId ?? null,
        dryRun: input.dryRun === true,
      },
      observer ?? {},
    );

    // THE ONE PLACE THE OUTCOME BECOMES A COVERAGE CLAIM. `checkpointMayAdvance`
    // lives beside the vocabulary it judges, so an outcome added later is refused
    // by default rather than falling through a list of today's failures.
    if (!checkpointMayAdvance(execution.outcome)) {
      return {
        checkpointBefore,
        checkpointAfter: checkpointBefore,
        plan,
        execution,
        advancement: 'NOT_PROVEN',
        reason:
          `The poll ended ${execution.outcome}, which does not prove the interval was covered. ` +
          'The checkpoint was left where it was; the interval will be read again.',
      };
    }

    // THE BOUNDARY IS THE INTERVAL'S, NOT THE CLOCK'S AND NOT THE NEWEST RECORD'S.
    // `plan.until` is exactly what the reader was asked for and exactly what it
    // proved complete, which is why it is the only honest thing to store.
    const advanced = await this.checkpoints.advance(
      input.organizationId,
      CALLGRID_POLL_PROVIDER,
      CALLGRID_POLL_STREAM,
      { completedThrough: plan.until, intervalSince: plan.since },
    );

    return {
      checkpointBefore,
      checkpointAfter: advanced.completedThrough,
      plan,
      execution,
      advancement: advanced.outcome,
      reason:
        advanced.outcome === 'ADVANCED'
          ? `Coverage is proven through ${advanced.completedThrough.toISOString()}.`
          : 'Another run had already proven at least this much; the checkpoint was left alone.',
    };
  }
}
