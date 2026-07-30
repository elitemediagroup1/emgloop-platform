import 'server-only';

// The seam where CallGrid Intelligence becomes a PRODUCER of platform primitives.
//
// Everything above this file is analysis: pure functions over reports producing
// Situations that exist only for the duration of one request. Everything below it
// is the organization's operational record, which outlives any analysis run and
// belongs to no single producer.
//
// The direction matters. CallGrid writes priorities and observations; it does not
// own them, and nothing here reaches back into CallGrid from the lifecycle layer.
// When CRM, Accounting or Website Intelligence start producing, they call the same
// repository with a different `sourceSystem` and inherit the whole queue, the whole
// lifecycle and the whole history for free. That is the entire reason the tables are
// shaped the way they are.
//
// CallGrid goes through the DECISION ENGINE, never through persistence. It has no
// privileged access to the tables, no ability to write an observation directly and
// no way to update a projection column — exactly the same position CRM,
// Accounting and Website Intelligence will be in. That is the test of whether this
// is a platform: the first producer must not be able to do anything the second
// one cannot.
//
// WHAT IS DELIBERATELY NOT HERE: no Work OS record is created, no CRM object is
// touched, no notification is sent. The engine publishes a domain event for every
// lifecycle change and those are future consumers of it, each its own branch.

import {
  callGridDetectionKey,
  callGridDetectedAt,
  summarizeHistory,
  summarizeDecisionActivity,
  buildEvidenceSnapshot,
  type Situation,
  type SituationQueue,
  type CallGridWindow,
  type PriorityState,
  type DecisionActivity,
  type LifecycleObservation,
  type LifecycleHistory,
  type DecisionEvidenceValue,
  type DecisionClaim,
} from "@emgloop/shared";
import { decisionEngine, repositories, type OperationalPriority, type OperationalObservation } from "@emgloop/database";

/** The producer's name in the lifecycle layer. One constant, used nowhere else. */
export const CALLGRID_SOURCE = "CALLGRID";

/** A Situation joined to its durable operational record. */
export interface LivePriority {
  situation: Situation;
  /** Null only when persistence failed — the analysis still renders. */
  record: OperationalPriority | null;
  state: PriorityState;
  ownerUserId: string | null;
  reopenCount: number;
  /** How many distinct analysis periods have seen this. 1 means "first time". */
  detectionCount: number;
  firstDetectedAt: Date | null;
  /**
   * The log, loaded only for the rows the page actually shows. Empty on the rest,
   * because replaying every log to render a row nobody expanded is a real cost
   * for nothing.
   */
  log: OperationalObservation[];
  history: LifecycleHistory | null;
}

export interface OperationalQueue {
  /** The analysis, unchanged. Still the source of every conclusion on the page. */
  queue: SituationQueue;
  /** Situations joined to their durable records, ordered as the engine ranked them. */
  items: LivePriority[];
  /** Real counts across ALL priorities for this producer, not just this period's. */
  counts: Record<PriorityState, number>;
  activity: DecisionActivity;
  /**
   * Open items (assigned or watched) regardless of whether this period detected
   * them. Work in progress does not stop existing because the operator changed
   * the date filter, and an item that silently vanished from the screen is how a
   * queue loses an operator's trust.
   */
  openWork: OperationalPriority[];
  /**
   * Set when the lifecycle layer could not be read or written. The page still
   * renders the analysis; it must not claim the queue state is durable when the
   * write failed, and it must not pretend everything is in NEEDS_REVIEW either.
   */
  persistenceError: string | null;
}

function toLifecycle(o: OperationalObservation): LifecycleObservation {
  return {
    id: o.id,
    sequence: o.sequence,
    observationType: o.observationType as LifecycleObservation["observationType"],
    occurredAt: o.occurredAt,
    recordedAt: o.recordedAt,
    actorType: o.actorType as LifecycleObservation["actorType"],
    actorUserId: o.actorUserId,
    source: o.source,
    note: o.note,
    assignedToUserId: o.assignedToUserId,
    outcome: o.outcome as LifecycleObservation["outcome"],
    measuredEffectCents: o.measuredEffectCents,
    measuredEffectBasis: o.measuredEffectBasis,
  };
}

/**
 * Snapshot everything the engine knew about a Situation, in the platform's
 * producer-neutral shape.
 *
 * The engine recomputes findings on every request, so an OPEN decision can always
 * show its evidence live. A decision resolved six weeks ago cannot: rule versions
 * move, thresholds change, and the window it was about is gone. Without this the
 * historical record keeps the conclusion and loses the reason — and the outcome
 * data that Loop will use to judge its own recommendations becomes impossible to
 * interpret.
 *
 * Limitations and unknowns are carried across deliberately. A snapshot that keeps
 * the finding and drops the caveats is how a hedged claim quietly becomes a
 * confident one.
 */
function evidenceFor(situation: Situation) {
  const values: DecisionEvidenceValue[] = situation.observations.flatMap((f) =>
    f.supportingEvidence.map((e) => ({
      metricKey: e.metricKey,
      source: e.providerReport,
      window: e.window,
      entityType: e.entityType,
      entityId: e.entityId,
      entityName: e.entityName,
      rawValue: e.rawValue,
      normalizedValue: e.normalizedValue,
      derivedValue: e.derivedValue,
      formula: e.formula,
      formulaVersion: e.formulaVersion,
      completeness: e.completeness,
    })),
  );

  const claims: DecisionClaim[] = situation.chain.links.map((l) => ({
    statement: l.statement,
    basis: l.basis,
  }));

  return buildEvidenceSnapshot({
    producer: CALLGRID_SOURCE,
    rules: situation.observations.map((f) => ({ ruleId: f.ruleId, ruleVersion: f.ruleVersion })),
    // The lead finding's confidence. Averaging across merged findings would
    // invent a number none of the rules produced.
    confidence: situation.observations[0]?.confidence ?? null,
    observationCount: situation.observationCount,
    claims,
    values,
    limitations: situation.observations.flatMap((f) => f.limitations),
    unknowns: situation.unknowns,
  });
}

/**
 * Build the queue and record what the engine saw.
 *
 * Detection is idempotent per analysis period (see `callGridDetectionKey`), so
 * this is safe to run on every render of a server-rendered page: twenty refreshes
 * produce one sighting, and tomorrow produces exactly one more.
 *
 * The writes run sequentially rather than in parallel. A queue is at most a
 * couple of dozen situations, and each write is one small transaction; running
 * them concurrently would buy milliseconds and cost the deterministic ordering
 * that makes the log readable.
 */
export async function loadOperationalQueue(
  organizationId: string,
  /**
   * The queue the engine already built. Taken rather than rebuilt: the engine
   * assembles it so the Overview and a subpage cannot disagree about what one
   * Situation is, and a second construction here would be exactly the parallel
   * system this repo keeps paying for.
   */
  queue: SituationQueue,
  context: {
    window: CallGridWindow;
    now: Date;
    /** How many rows the surface will render, and therefore how many logs to load. */
    logLimit?: number;
  },
): Promise<OperationalQueue> {
  const detectionKey = callGridDetectionKey(context.window);
  const detectedAt = callGridDetectedAt(context.window, context.now);

  const items: LivePriority[] = [];
  let persistenceError: string | null = null;

  try {
    for (const situation of queue.situations) {
      const { decision: priority } = await decisionEngine.create(organizationId, {
        producer: CALLGRID_SOURCE,
        recurrenceKey: situation.key,
        detectionKey,
        detectedAt,
        title: situation.title,
        summary: situation.whatHappened,
        severity: situation.severity,
        impactCents: situation.impact.amountCents,
        impactLabel: situation.impact.label,
        sourceReference: situation.observations[0]?.affectedEntities[0]?.entityId ?? null,
        producerVersion: situation.version,
        confidence: situation.observations[0]?.confidence ?? null,
        // Evidence as first-class rows, so it can be appended to later. The
        // snapshot is kept too: it is the opening picture, which stays true even
        // as evidence accumulates.
        evidence: situation.observations.flatMap((f) =>
          f.supportingEvidence.slice(0, 8).map((e) => ({
            source: e.providerReport,
            metricKey: e.metricKey,
            window: e.window,
            ruleId: f.ruleId,
            ruleVersion: f.ruleVersion,
            formulaVersion: e.formulaVersion,
            confidence: f.confidence,
            rawValue: e.rawValue,
            normalizedValue: e.normalizedValue,
            derivedValue: e.derivedValue,
            completeness: e.completeness,
            entityType: e.entityType,
            entityId: e.entityId,
            entityName: e.entityName,
            limitations: f.limitations,
            unknowns: f.unknowns,
            observedAt: detectedAt,
          })),
        ),
        evidenceSnapshot: evidenceFor(situation) as unknown as Record<string, unknown>,
        // The belief, recorded alongside the operational thread on a FIRST
        // sighting only. Always PROPOSED — Loop never accepts its own guess.
        hypothesis: {
          hypothesisType: situation.observations[0]?.ruleId ?? "callgrid.situation",
          title: situation.title,
          summary: situation.read.claim,
          confidence: situation.observations[0]?.confidence ?? null,
          ruleVersion: situation.observations[0]?.ruleVersion ?? null,
          supportingWindowStart: context.window.start,
          supportingWindowEnd: context.window.end,
        },
      });
      items.push({
        situation,
        record: priority,
        state: priority.state as PriorityState,
        ownerUserId: priority.ownerUserId,
        reopenCount: priority.reopenCount,
        detectionCount: priority.detectionCount,
        firstDetectedAt: priority.firstDetectedAt,
        log: [],
        history: null,
      });
    }

    // Logs for the rows that will actually render.
    for (const item of items.slice(0, context.logLimit ?? 3)) {
      if (!item.record) continue;
      const log = await decisionEngine.getHistory(organizationId, item.record.id);
      item.log = log;
      item.history = summarizeHistory(log.map(toLifecycle));
    }
  } catch (e) {
    // The analysis is still true and still worth showing. What must not happen is
    // the page silently rendering every item as NEEDS_REVIEW as though nobody had
    // ever touched them — an operator would re-do work they already did.
    persistenceError =
      "Loop could not reach the operational record for this period, so ownership and status below may be out of date. The analysis itself is unaffected.";
    for (const situation of queue.situations) {
      if (items.some((i) => i.situation.key === situation.key)) continue;
      items.push({
        situation,
        record: null,
        state: "NEEDS_REVIEW",
        ownerUserId: null,
        reopenCount: 0,
        detectionCount: 0,
        firstDetectedAt: null,
        log: [],
        history: null,
      });
    }
    console.error("[operational-queue] detection failed", e);
  }

  // Lane counts and activity span EVERY priority this producer has ever opened,
  // not just the ones detected in the selected period. An item assigned last week
  // and still open is part of the operator's workload today even if the window
  // they are looking at does not contain it.
  let counts: Record<PriorityState, number> = {
    NEEDS_REVIEW: 0, ASSIGNED: 0, WATCHING: 0, RESOLVED: 0, DISMISSED: 0,
  };
  let activity = summarizeDecisionActivity([]);
  let openWork: OperationalPriority[] = [];
  try {
    counts = await decisionEngine.countsByState(organizationId, CALLGRID_SOURCE);
    activity = await loadDecisionActivity(organizationId);
    openWork = await decisionEngine.list(organizationId, {
      producer: CALLGRID_SOURCE,
      states: ["ASSIGNED", "WATCHING"],
      take: 25,
    });
  } catch (e) {
    persistenceError = persistenceError
      ?? "Loop could not read the operational record, so the lane counts below are unavailable rather than zero.";
    console.error("[operational-queue] lane counts failed", e);
  }

  return { queue, items, counts, activity, openWork, persistenceError };
}

/**
 * Organisation-wide decision activity for this producer.
 *
 * Resolution durations need the log, so this reads observations for the closed
 * priorities only — the open ones have no resolution time by definition, and
 * replaying every log on every page load would be a real cost for a figure that
 * cannot exist.
 */
export async function loadDecisionActivity(organizationId: string): Promise<DecisionActivity> {
  const priorities = await decisionEngine.list(organizationId, {
    producer: CALLGRID_SOURCE,
    take: 500,
  });

  const closed = priorities.filter((p) => p.state === "RESOLVED" || p.state === "DISMISSED");
  const durations = new Map<string, number | null>();
  for (const p of closed) {
    const log = await decisionEngine.getHistory(organizationId, p.id);
    durations.set(p.id, summarizeHistory(log.map(toLifecycle)).msToResolution);
  }

  return summarizeDecisionActivity(
    priorities.map((p) => ({
      state: p.state as PriorityState,
      outcome: p.outcome,
      measuredEffectCents: p.measuredEffectCents,
      reopenCount: p.reopenCount,
      msToResolution: durations.get(p.id) ?? null,
    })),
  );
}

/** One priority with its full log, for the detail view. */
export interface PriorityDetail {
  priority: OperationalPriority;
  observations: OperationalObservation[];
  history: LifecycleHistory;
  state: PriorityState;
}

export async function loadPriorityDetail(
  organizationId: string,
  priorityId: string,
): Promise<PriorityDetail | null> {
  const found = await decisionEngine.get(organizationId, priorityId);
  if (!found) return null;
  // Projected here rather than trusted from the row, so the detail view is the
  // one place that can never show a stale cache.
  return {
    priority: found.decision,
    observations: found.observations,
    history: found.history,
    state: found.currentState,
  };
}
