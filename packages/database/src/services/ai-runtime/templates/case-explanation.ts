// The Case Explanation template, version 1. Slice B5 (AI S1 preparation).
//
// A TEMPLATE IS REVIEWED CODE, NOT A STRING SOMEBODY TYPED AT A CALL SITE. It is
// versioned, the version is recorded in provenance, and changing it is a pull
// request -- because the instruction is the largest single influence on what a model
// says, and an unversioned prompt makes every past answer unexplainable.
//
// WHAT IT ASKS FOR IS WHAT LOOP WILL ACCEPT. The output contract rejects an uncited
// claim, an invented citation, an unsupported figure, a self-scored confidence and a
// recommendation. So the instruction states those rules plainly rather than hoping:
// a model told the constraints produces fewer rejections, and a model that breaks
// them anyway is refused either way.
//
// PURE. No clock, no I/O, no interpolation of anything but block ids.

export const CASE_EXPLANATION_TEMPLATE_ID = 'case-explanation';
export const CASE_EXPLANATION_TEMPLATE_VERSION = '1';

/**
 * The system instruction. It names the source refs the model may cite, because a
 * citation it invents is rejected and telling it the allowed set is the difference
 * between a rejection and an answer.
 */
export function renderCaseExplanationInstructions(sourceRefs: readonly string[]): string {
  return [
    'You explain a commercial intelligence Case to an operator, using only the evidence supplied.',
    '',
    'Rules, all of which are enforced after you answer:',
    '1. Every claim must cite at least one supplied source reference. A claim with no citation is rejected.',
    '2. You may only cite these references, exactly as written:',
    ...sourceRefs.map((ref) => `   - ${ref}`),
    '3. Every number you state must appear in the supplied evidence. Do not compute, estimate or round into a new figure.',
    '4. Do not state a confidence, probability, likelihood or percentage certainty about your own answer.',
    '5. Do not recommend an action, suggest a next step, or tell the reader what to do. Explain what the evidence shows.',
    '6. If the evidence does not answer something, say so in `limitations`. An honest gap is the correct answer.',
    '',
    'Return only the JSON object the schema describes.',
  ].join('\n');
}

/** The output schema, by id. The runtime passes it to providers that support one natively. */
export const CASE_EXPLANATION_SCHEMA_ID = 'case-explanation.v1';

export const CASE_EXPLANATION_SCHEMA: Record<string, unknown> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schemaId', 'summary', 'claims', 'limitations'],
  properties: {
    schemaId: { type: 'string', const: CASE_EXPLANATION_SCHEMA_ID },
    summary: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['statement', 'citations', 'figures'],
        properties: {
          statement: { type: 'string' },
          citations: { type: 'array', items: { type: 'string' } },
          figures: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'value'],
              properties: { label: { type: 'string' }, value: { type: 'number' } },
            },
          },
        },
      },
    },
    limitations: { type: 'array', items: { type: 'string' } },
  },
});
