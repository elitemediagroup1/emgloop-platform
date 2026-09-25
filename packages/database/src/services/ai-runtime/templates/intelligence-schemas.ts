// The output schemas of the Loop Intelligence tasks whose answer shape is not a domain reading or a
// conversation triage (Phases F-G): situation synthesis, situation verification and the Briefing. Keyed by
// schema id so the portable-schema test covers every task a later phase adds. Filled by those phases.

export const INTELLIGENCE_TASK_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({});
