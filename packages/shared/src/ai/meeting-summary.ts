import type { AiTaskOutput, AiOutputRejection } from './task';

export const MEETING_SUMMARY_SCHEMA_ID = 'meeting-summary.v1';
export const MEETING_SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['schemaId', 'summary'],
  properties: { schemaId: { type: 'string', enum: [MEETING_SUMMARY_SCHEMA_ID] }, summary: { type: 'string' } },
};

export function parseMeetingSummary(value: unknown): AiTaskOutput | null {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2 ||
      !('schemaId' in value) || value.schemaId !== MEETING_SUMMARY_SCHEMA_ID ||
      !('summary' in value) || typeof value.summary !== 'string') return null;
  return { schemaId: MEETING_SUMMARY_SCHEMA_ID, summary: value.summary.trim(), claims: [], limitations: [] };
}

export function validateMeetingSummary(output: AiTaskOutput): AiOutputRejection[] {
  if (!output.summary) return ['EMPTY_ANSWER'];
  return output.summary.length > 4500 ? ['ANSWER_TOO_LONG'] : [];
}
