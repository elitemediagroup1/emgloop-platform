// A deliberately shared creator update, distinct from private Mail triage. Pure.
import { aiDatesInText, aiNumbersInText, aiHasQuotation, aiVerbatimRuns, type AiTaskOutput, type AiTaskDefinition, type AiSupportedEvidence, type AiOutputRejection } from './task';
export const CREATOR_BRAND_UPDATE_SCHEMA_ID = 'creator-brand-update.v1';
export const CREATOR_BRAND_STAGES = ['OUTREACH', 'DISCUSSING', 'AWAITING_EMG', 'AWAITING_BRAND', 'AWAITING_CREATOR', 'NEGOTIATING', 'CONFIRMED', 'DECLINED', 'PAUSED'] as const;
export interface CreatorBrandUpdate {
  readonly publishable: boolean;
  readonly brandName?: string | null;
  readonly stage: typeof CREATOR_BRAND_STAGES[number];
  /** Absent on legacy readings, which cannot establish an active deal. */
  readonly dealQualification?: 'NONE' | 'CURRENT_PAID_NEGOTIATION' | 'CURRENT_PAID_AGREEMENT';
  readonly summary: string;
  readonly nextStep: string;
  readonly citations: readonly string[];
}
export const CREATOR_BRAND_UPDATE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['schemaId', 'publishable', 'stage', 'summary', 'nextStep', 'citations', 'brandName', 'dealQualification'],
  properties: {
    brandName: { type: ['string', 'null'] },
    dealQualification: { type: 'string', enum: ['NONE', 'CURRENT_PAID_NEGOTIATION', 'CURRENT_PAID_AGREEMENT'] },
    schemaId: { type: 'string', enum: [CREATOR_BRAND_UPDATE_SCHEMA_ID] }, publishable: { type: 'boolean' },
    stage: { type: 'string', enum: [...CREATOR_BRAND_STAGES] }, summary: { type: 'string' }, nextStep: { type: 'string' },
    citations: { type: 'array', items: { type: 'string' } },
  },
});
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function parseCreatorBrandUpdate(v: unknown): AiTaskOutput | null {
  if (!object(v) || Object.keys(v).some(k => !['schemaId', 'publishable', 'stage', 'summary', 'nextStep', 'citations', 'brandName', 'dealQualification'].includes(k)) || (v.dealQualification !== undefined && !['NONE', 'CURRENT_PAID_NEGOTIATION', 'CURRENT_PAID_AGREEMENT'].includes(v.dealQualification as string)) || v.schemaId !== CREATOR_BRAND_UPDATE_SCHEMA_ID || (v.brandName !== undefined && v.brandName !== null && typeof v.brandName !== 'string') || typeof v.publishable !== 'boolean' || !CREATOR_BRAND_STAGES.includes(v.stage as never) || typeof v.summary !== 'string' || typeof v.nextStep !== 'string' || !Array.isArray(v.citations) || !v.citations.every(r => typeof r === 'string')) return null;
  const update: CreatorBrandUpdate = { ...(v.dealQualification !== undefined ? { dealQualification: v.dealQualification as CreatorBrandUpdate['dealQualification'] } : {}), ...(v.brandName !== undefined ? { brandName: v.brandName as string | null } : {}), publishable: v.publishable, stage: v.stage as CreatorBrandUpdate['stage'], summary: v.summary, nextStep: v.nextStep, citations: v.citations };
  return { schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, summary: update.summary, claims: [], limitations: [], creatorBrandUpdate: update };
}
export function validateCreatorBrandUpdate(output: AiTaskOutput, task: AiTaskDefinition, refs: ReadonlySet<string>, evidence: AiSupportedEvidence): AiOutputRejection[] {
  const u = output.creatorBrandUpdate;
  if (!u || output.schemaId !== task.outputSchemaId) return ['WRONG_SCHEMA'];
  const out: AiOutputRejection[] = [];
  if (!u.publishable) return u.summary === '' && u.nextStep === '' && u.citations.length === 0 ? [] : ['WRONG_SCHEMA'];
  if (u.brandName !== undefined && u.brandName !== null && (!/^[\p{L}\p{N}][\p{L}\p{N} &.'’+()-]{1,99}$/u.test(u.brandName) || /https?|www|@/i.test(u.brandName))) out.push('WRONG_SCHEMA');
  if (!u.summary.trim()) out.push('EMPTY_ANSWER');
  if (u.summary.length > 600 || u.nextStep.length > 200 || u.citations.length > 8) out.push('ANSWER_TOO_LONG');
  if (!u.citations.length) out.push('UNCITED_CLAIM');
  if (u.citations.some(r => !refs.has(r) || !r.startsWith('mail_message:'))) out.push('CITATION_NOT_SUPPLIED');
  const text = `${u.summary} ${u.nextStep}`;
  // No prices, commissions, identifiers, URLs or copied quotations on this publication surface.
  if (/@|https?:|www\.|\$|€|£|\b(?:USD|commission|margin|pricing|budget|fee|payment|rate|password|token|confidential|internal.only)\b/i.test(text) || /\b\+?\d[\d ().-]{7,}\d\b/.test(text)) out.push('VERBATIM_CONTENT');
  if (aiHasQuotation(text) || [...aiVerbatimRuns(text)].some(r => evidence.verbatimRuns?.has(r))) out.push('VERBATIM_CONTENT');
  const numbers = new Set(u.citations.flatMap(r => [...(evidence.figures.get(r) ?? [])]));
  if (aiNumbersInText(text).some(n => !numbers.has(n))) out.push('UNSUPPORTED_NUMBER_IN_TEXT');
  if (aiDatesInText(text).some(d => !evidence.dates.has(d))) out.push('UNSUPPORTED_DATE_IN_TEXT');
  return [...new Set(out)];
}
export const CREATOR_MAIL_SHARING_DECISION = 'creator-mail-sharing:2026-10-29:v1';

export const CREATOR_BRAND_REFRESH_MS = 5 * 60_000;
export const CREATOR_BRAND_FRESH_MS = 10 * 60_000;

/** Publication fails conservatively for old or unqualified active-deal labels.
 * A conversation remains visible while the stricter classification awaits review.
 */
export function publishedCreatorBrandStage(update: Pick<CreatorBrandUpdate, 'stage' | 'dealQualification'>): CreatorBrandUpdate['stage'] {
  if (update.stage === 'NEGOTIATING' && update.dealQualification !== 'CURRENT_PAID_NEGOTIATION') return 'DISCUSSING';
  if (update.stage === 'CONFIRMED' && update.dealQualification !== 'CURRENT_PAID_AGREEMENT') return 'DISCUSSING';
  return update.stage;
}
