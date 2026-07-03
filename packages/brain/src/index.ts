export * from './brain-activity-verification';
// @emgloop/brain â package barrel.
//
// Sprint 12: EMG Brain Foundation. The Brain is the center of the platform; CRM,
// Analytics, AI Employees, Workflows, Portals and every EMG property are
// interfaces into it. This package establishes the PERMANENT architecture â
// contracts and deterministic scaffolding only. No AI, no provider integrations,
// no DB coupling (depends solely on @emgloop/shared). It is intentionally not yet
// wired into the web app build; future sprints provide concrete implementations.

export * from './types';
export * from './facts';
export * from './pipeline';
export * from './signals';
export * from './memory';
export * from './identity';
export * from './graph';
export * from './knowledge';
export * from './recommendation';
export * from './next-best-action';
export * from './diagnostics';
export * from './diagnostics-recommendation';
export * from './buyer-call-handling-diagnoser';
export * from './brain-activity';
export * from './revenue';
export * from './trust';
export * from './verticals';
export * from './integration-hub';
export * from './services';
export * from './call-handling-metrics-assembler';
