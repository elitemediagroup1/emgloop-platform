// What Loop is willing to send, and the authority it came from. Slice AI S0.
//
// Architecture: docs/architecture/loop-ai-runtime.md §7 (F4). A ContextPackage is
// assembled by the runtime from repositories the INVOKING USER may already read,
// and every block names its source. That manifest is the whole point: it is what
// lets a claim be checked against the evidence that produced it, and what makes
// "the model said so" a sentence Loop never has to accept.
//
// THE CEILING IS THE POINT. A task declares the highest sensitivity class it may
// send. A block above that ceiling is not redacted, summarised or truncated -- the
// package is REFUSED. Silently dropping the one block that mattered produces a
// confident answer built on less than the reader thinks, which is worse than no
// answer at all.
//
// AUTHORIZATION IS INHERITED, NEVER WIDENED. Context is assembled as the invoking
// user, in one organization. There is no service account that "just reads what it
// needs": if the person cannot see it, it does not go.

import { AI_CONTENT_TRUST_LEVELS, type AiContentBlock, type AiContentTrustLevel } from './provider';

/** Mirrors `activity.v1`'s classes so one word means one thing across Loop. */
export const AI_SENSITIVITY_CLASSES = ['OPERATIONAL', 'CONTACT_IDENTIFIER', 'COMMUNICATION_CONTENT', 'WORKFORCE_PII'] as const;
export type AiSensitivityClass = (typeof AI_SENSITIVITY_CLASSES)[number];

/** Least to most sensitive. A ceiling admits everything at or below it. */
const SENSITIVITY_ORDER: readonly AiSensitivityClass[] = [
  'OPERATIONAL',
  'CONTACT_IDENTIFIER',
  'COMMUNICATION_CONTENT',
  'WORKFORCE_PII',
];

export function aiSensitivityRank(sensitivity: string): number {
  const index = SENSITIVITY_ORDER.indexOf(sensitivity as AiSensitivityClass);
  // Fails closed: something nobody classified is treated as the most sensitive
  // thing there is, so it can only travel under the widest ceiling -- which no
  // task has at launch.
  return index === -1 ? SENSITIVITY_ORDER.length : index;
}

export interface AiContextItem extends AiContentBlock {
  readonly sensitivity: AiSensitivityClass;
  /** The permission the invoking user held to read this, re-checked at assembly. */
  readonly readUnder: { readonly resource: string; readonly action: 'view' };
}

export interface AiContextPackage {
  readonly organizationId: string;
  /** Whose authority assembled this. There is no other authority available. */
  readonly viewerUserId: string;
  readonly taskId: string;
  readonly items: readonly AiContextItem[];
  /** The highest class this task may send, from its definition. */
  readonly sensitivityCeiling: AiSensitivityClass;
}

export const AI_CONTEXT_REFUSALS = [
  'EMPTY_CONTEXT',
  'ABOVE_SENSITIVITY_CEILING',
  'CROSS_ORGANIZATION_BLOCK',
  'MISSING_SOURCE_REF',
  'MISSING_READ_AUTHORITY',
  'UNKNOWN_TRUST_LEVEL',
] as const;
export type AiContextRefusal = (typeof AI_CONTEXT_REFUSALS)[number];

/**
 * Everything wrong with a package, before anything is sent. Empty means it may go.
 *
 * A package with no items is refused rather than sent: a model asked to explain
 * nothing will still write something, and that something would read like analysis.
 */
export function validateAiContextPackage(pkg: AiContextPackage): AiContextRefusal[] {
  const out: AiContextRefusal[] = [];
  if (pkg.items.length === 0) out.push('EMPTY_CONTEXT');
  const ceiling = aiSensitivityRank(pkg.sensitivityCeiling);
  for (const item of pkg.items) {
    if (aiSensitivityRank(item.sensitivity) > ceiling) out.push('ABOVE_SENSITIVITY_CEILING');
    if (!item.sourceRef?.trim() || !item.sourceRef.includes(':')) out.push('MISSING_SOURCE_REF');
    if (!item.readUnder?.resource?.trim() || item.readUnder.action !== 'view') out.push('MISSING_READ_AUTHORITY');
    if (!(AI_CONTENT_TRUST_LEVELS as readonly string[]).includes(item.trust)) out.push('UNKNOWN_TRUST_LEVEL');
    // A block that names another organization's record has no business here, and
    // no ceiling makes it acceptable.
    if (item.blockId.includes('::') && !item.blockId.startsWith(`${pkg.organizationId}::`)) out.push('CROSS_ORGANIZATION_BLOCK');
  }
  return [...new Set(out)];
}

/** The source refs a package offered, which is the only set a claim may cite. */
export function aiContextSourceRefs(pkg: AiContextPackage): Set<string> {
  return new Set(pkg.items.map((item) => item.sourceRef));
}

/** Trust as the model should treat it: anything a person or provider asserted is not a Loop fact. */
export function aiBlockIsGovernedFact(trust: AiContentTrustLevel): boolean {
  return trust === 'GOVERNED_FACT';
}
