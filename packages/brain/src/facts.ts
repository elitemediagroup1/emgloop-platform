// @emgloop/brain — Fact: the atomic unit a Sensor emits.
//
// Phase 1 (Sensor Boundary). A Fact is an OBSERVATION, not an interpretation.
// Sensors (providers) observe the outside world and emit Facts. They never
// score, recommend, diagnose, or optimize — that is the Brain's job. A Fact is
// immutable once recorded: it states that something was observed, by whom, when,
// and with what raw payload. The Brain consumes Facts to build Signals,
// Knowledge, and Recommendations.

import type { Metadata } from '@emgloop/shared';

/** Stable machine name of the sensor that produced a fact, e.g. 'callgrid',
 *  'website', 'orders'. */
export type SensorId = string;

/**
 * A single observed fact. Provider-agnostic and interpretation-free.
 *
 * Design rules:
 *  - A Fact asserts WHAT was observed, never what it MEANS.
 *  - A Fact is idempotent via (sensorId, externalId).
 *  - A Fact carries no confidence score: an observation either happened or did
 *    not. Confidence lives on Brain-derived objects, not on raw Facts.
 */
export interface Fact {
  /** Which sensor observed this. */
  sensorId: SensorId;
  /** Idempotency key within the sensor's own system. */
  externalId: string;
  /** Organization the fact belongs to (tenant scope). */
  organizationId: string;
  /** Canonical, sensor-agnostic fact type, e.g. 'call.completed',
   *  'web.session', 'order.paid'. Normalization maps raw source types to this. */
  type: string;
  /** When the observation occurred in the real world (source time). */
  observedAt: Date;
  /** When Loop recorded the fact (ingest time). */
  recordedAt: Date;
  /** Optional customer/identity this fact concerns, if the sensor resolved one. */
  subjectId?: string;
  /** Structured, normalized attributes of the observation. Values are plain
   *  data — no derived scores, no recommendations. */
  attributes: Metadata;
  /** The untouched raw payload from the source, retained for auditability and
   *  future re-normalization. */
  raw: Record<string, unknown>;
}

/** The result a Sensor returns from emitFacts(): the facts observed in a batch,
 *  plus honest counts. A Sensor reports what it saw and what it could not
 *  process — it never hides failures. */
export interface FactBatch {
  facts: Fact[];
  /** Number of source records seen. */
  observed: number;
  /** Number successfully normalized into facts. */
  emitted: number;
  /** Number skipped as duplicates (idempotency). */
  duplicates: number;
  /** Number that could not be normalized (with reasons, for diagnostics). */
  failed: number;
  /** Non-fatal issues encountered, surfaced honestly to the Integration OS. */
  issues: string[];
}
