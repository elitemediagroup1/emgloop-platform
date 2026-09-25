// The Loop AI runtime contracts (slice AI S0). Pure: no SDK, no key, no call.
//
// Loop owns the authorities, the context, the permissions, the routing, the
// provenance, the validation and the record. A provider answers a question it was
// handed, and nothing here lets one do more than that.
export * from './provider';
export * from './context';
export * from './runtime';
export * from './task';
// PR 1 (AI runtime): lanes, the recorded operating budget and its cost ceilings; the output-contract
// registry the gateway validates answers through; the structured-output subset both providers accept.
export * from './capacity';
export * from './output-contracts';
export * from './portable-schema';
// PR 2 (Loop Intelligence fabric): the one generic, portable domain-reading output contract.
export * from './domain-reading';
// Chats v5 (Loop Intelligence Phase B): the portable triage schema v5 contract.
export * from './telegram-triage-v5';

// Brain execution contracts (B2): capability routes, execution classes, result types and
// ownership, jobs, steps, the trust envelope and the executor port. Contracts only.
export * from './capability';
export * from './brain-execution';
export * from './brain-result';
export * from './brain-job';
export * from './brain-step';
export * from './brain-trust';
export * from './brain-executor';
// B3: dispatch identities, job leases, the worker's requests to Loop, step-start
// deadlines and the run-time routing gate. Contracts only.
export * from './brain-dispatch';
// B4: how a person answers a waiting job, and the stored control log's contract.
export * from './brain-wait';
export * from './ai-controls';
// G2 (2026-09-24): the recorded approval to send a class of data to one provider.
export * from './provider-policy';
// B5: the structured question a durable job may ask, and its reply.
export * from './brain-question';

// The business day a usage row is budgeted against. The organization's own
// reporting zone, read in exactly one place and never used for display.
export * from './budget-day';
