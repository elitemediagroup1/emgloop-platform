// The output schemas of the Loop Intelligence tasks whose answer shape is not a domain reading or a
// conversation triage (Phases F-G): situation synthesis, situation verification and the Briefing. Keyed by
// schema id so the portable-schema test covers every task a later phase adds.

import { BRIEFING_SCHEMA, BRIEFING_SCHEMA_ID, SITUATION_SYNTHESIS_SCHEMA, SITUATION_SYNTHESIS_SCHEMA_ID, SITUATION_VERIFICATION_SCHEMA, SITUATION_VERIFICATION_SCHEMA_ID } from '@emgloop/shared';

export const INTELLIGENCE_TASK_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  [SITUATION_SYNTHESIS_SCHEMA_ID]: SITUATION_SYNTHESIS_SCHEMA,
  [SITUATION_VERIFICATION_SCHEMA_ID]: SITUATION_VERIFICATION_SCHEMA,
  [BRIEFING_SCHEMA_ID]: BRIEFING_SCHEMA,
});
