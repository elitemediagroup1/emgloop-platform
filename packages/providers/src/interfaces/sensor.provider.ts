// Sensor — the formal contract every provider satisfies as a pure observer.
//
// Phase 1 (Sensor Boundary). The EMG Loop Constitution states: "Integrations are
// Sensors. They produce facts, never recommendations." This interface makes that
// boundary explicit and enforceable. A Sensor's entire job is:
//
//   observe()    — pull/receive raw events from the outside world
//   normalize()  — map a raw event to Loop's canonical vocabulary
//   emitFacts()   — produce immutable Facts for the Brain to consume
//   health()     — report whether the sensor can currently observe
//   capabilities()— declare what this sensor can and cannot do
//
// A Sensor MUST NOT: score, rank, diagnose, recommend, optimize, or write to the
// Brain's Knowledge/Recommendation layers. Those are Brain responsibilities.
//
// This is additive: existing adapters continue to implement IngestionProvider.
// Sensor is the target contract they converge on; the two are intentionally
// aligned (InboundEvent, IngestionCapabilities are reused, not duplicated).

import type { Fact, FactBatch } from '@emgloop/brain';
import type { BaseProvider, ProviderContext, ProviderHealth } from '../types';
import type { InboundEvent, IngestionCapabilities } from './ingestion.provider';

/** Window of time / cursor a Sensor observes over during a pull. */
export interface ObserveWindow {
  /** Observe events at or after this instant, if the source supports it. */
  since?: Date;
  /** Observe events before this instant, if the source supports it. */
  until?: Date;
  /** Opaque cursor for incremental pulls, if the source supports it. */
  cursor?: string;
  /** Soft cap on the number of raw events to pull in one observe(). */
  limit?: number;
}

/** Result of an observe() pull: raw events plus an optional next cursor. */
export interface ObserveResult {
  events: InboundEvent[];
  /** Cursor to pass to the next observe() for incremental progress. */
  nextCursor?: string;
  /** Whether more events remain beyond this batch. */
  hasMore: boolean;
}

/**
 * The pure-observer contract. Every provider that feeds the Brain implements
 * Sensor. It extends BaseProvider (info + healthCheck) so a Sensor is also a
 * standard provider, but adds the observe -> normalize -> emit pipeline.
 */
export interface Sensor extends BaseProvider {
  /** Declare what this sensor can and cannot do. */
  capabilities(): IngestionCapabilities;

  /** Report whether the sensor can currently observe (auth/connectivity). */
  health(ctx: ProviderContext): Promise<ProviderHealth>;

  /** Pull raw events from the source system. For webhook-only sensors this may
   *  simply return an empty batch; delivery arrives via the webhook route. */
  observe(ctx: ProviderContext, window: ObserveWindow): Promise<ObserveResult>;

  /** Map a single raw event to zero or more canonical Facts. Pure and
   *  deterministic: no I/O, no scoring, no side effects. */
  normalize(ctx: ProviderContext, event: InboundEvent): Fact[];

  /** Observe + normalize a batch and return Facts with honest counts. This is
   *  the method the ingestion host calls; it composes observe() and
   *  normalize(). It emits Facts only — never recommendations. */
  emitFacts(ctx: ProviderContext, window: ObserveWindow): Promise<FactBatch>;
}
