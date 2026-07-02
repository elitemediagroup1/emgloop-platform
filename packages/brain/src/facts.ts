// @emgloop/brain — Fact (re-export).
//
// Phase 1 (Sensor Boundary). The canonical Fact / FactBatch types are defined in
// @emgloop/providers, where Sensors (their sole producers) live. The platform's
// dependency direction is brain -> providers, so the Brain re-exports these
// types for ergonomic access (import { Fact } from '@emgloop/brain') without
// duplicating the definition or inverting the dependency. Facts remain the
// atomic, interpretation-free unit the Brain consumes to build Signals,
// Knowledge, and Recommendations.

export type { Fact, FactBatch, SensorId } from '@emgloop/providers';
