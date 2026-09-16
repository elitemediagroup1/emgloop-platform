// The Loop AI runtime contracts (slice AI S0). Pure: no SDK, no key, no call.
//
// Loop owns the authorities, the context, the permissions, the routing, the
// provenance, the validation and the record. A provider answers a question it was
// handed, and nothing here lets one do more than that.
export * from './provider';
export * from './context';
export * from './runtime';
export * from './task';

// Brain execution contracts (B2): capability routes, execution classes, result types and
// ownership, jobs, steps, the trust envelope and the executor port. Contracts only.
export * from './capability';
export * from './brain-execution';
export * from './brain-result';
export * from './brain-job';
export * from './brain-step';
export * from './brain-trust';
export * from './brain-executor';

// The business day a usage row is budgeted against. The organization's own
// reporting zone, read in exactly one place and never used for display.
export * from './budget-day';
