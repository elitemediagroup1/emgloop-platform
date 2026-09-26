// Promote to Work: the ONE bridge from intelligence to Work OS. Loop Intelligence Phase C, 2026-09-26.
//
// INTELLIGENCE IDENTIFIES THE NEED; WORK OS MANAGES THE WORK. A reading may say "you may owe: send
// Premier the revised allocation". Nothing makes that work except a person who looks at the evidence
// and chooses to promote it. From that confirmation on, Work OS owns the assignee, the target date, the
// state, the workflow and the completion. AI never creates work.
//
// WHAT A PROMOTION SHARES IS SHOWN, THEN CONFIRMED. A private origin (a person's own chat or mail
// reading, their own Daily Loop item) becomes visible to everyone who can see the organization's work
// ONLY through the title and outcome the person confirms -- nothing else of the conversation travels.
// The proposal says exactly which fields become shared, the person may edit them, and the promotion
// re-resolves the origin and refuses when what they saw has changed (STALE_CONFIRMATION).
//
// A SUGGESTION IS NOT AUTHORITY. The proposal suggests the person themselves as the assignee. Anyone may
// create work for themselves; assigning it to someone else needs the authority to administer the
// organization's work (`work:manage` -- the platform has no separate `work:assign` action today).
//
// PURE.

export const PROMOTE_ORIGIN_KINDS = ['DIGEST_SIGNAL', 'WORK_ITEM', 'CASE'] as const;
export type PromoteOriginKind = (typeof PROMOTE_ORIGIN_KINDS)[number];

export type PromoteOrigin =
  | {
      readonly kind: 'DIGEST_SIGNAL';
      readonly scope: 'PRINCIPAL' | 'ORGANIZATION';
      readonly domain: string;
      readonly subjectKind: string;
      readonly subjectRef: string;
      readonly signalKey: string;
    }
  | { readonly kind: 'WORK_ITEM'; readonly itemId: string }
  | { readonly kind: 'CASE'; readonly caseId: string };

/** The fields a promotion can make shared. Their VALUES are the work instance's own. */
export const PROMOTE_SHARED_FIELDS = ['title', 'outcome', 'targetDate', 'assignee'] as const;
export type PromoteSharedField = (typeof PROMOTE_SHARED_FIELDS)[number];

export const PROMOTE_TITLE_MAX_CHARS = 140;
export const PROMOTE_OUTCOME_MAX_CHARS = 500;

export interface PromoteProposal {
  readonly origin: PromoteOrigin;
  /** Where the origin lives, in words ("Your chats", "Your mail", "Case"). Never a conversation's content. */
  readonly originLabel: string;
  /** PRINCIPAL: private until confirmed. ORGANIZATION: already the organization's. */
  readonly originScope: 'PRINCIPAL' | 'ORGANIZATION';
  readonly title: string;
  readonly outcome: string;
  /** The person themselves. A suggestion, never an assignment. */
  readonly suggestedAssigneeUserId: string;
  /** A target date only when the evidence carried one Loop can read as a date; else null. */
  readonly targetAt: Date | null;
  /** Exactly what becomes visible to people who can see the organization's work. */
  readonly sharedFields: readonly PromoteSharedField[];
  /** What the person is looking at; the promotion refuses when the origin no longer matches it. */
  readonly fingerprint: string;
  /**
   * Minted at preview and carried by the confirmation form: one confirmed SUBMISSION creates exactly one
   * piece of work, so a retried submission returns the same work, while a new preview (a new nonce) may
   * promote the same origin again. Not a secret and not an authority -- the actor is re-resolved.
   */
  readonly submissionNonce: string;
  /** How many pieces of work this origin is already linked to (a count, never whose work it is). */
  readonly alreadyLinkedCount: number;
}

/** A submission nonce: URL-safe, 16-64 characters. */
export const PROMOTE_SUBMISSION_NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export const PROMOTE_REFUSALS = [
  'NOT_FOUND',
  'NOT_PERMITTED',
  'STALE',
  'STALE_CONFIRMATION',
  'NOT_CONFIRMED',
  'INVALID_INPUT',
  'WORK_TYPE_NOT_FOUND',
  'ASSIGNEE_NOT_PERMITTED',
  'ASSIGNEE_NOT_A_MEMBER',
  'NOT_MIGRATED',
] as const;
export type PromoteRefusal = (typeof PROMOTE_REFUSALS)[number];

/** Everything wrong with what a person confirmed, before anything is read. */
export function promoteConfirmationRefusal(c: { readonly title: string; readonly outcome: string; readonly confirmed: boolean; readonly targetAt: Date | null; readonly submissionNonce?: string }): PromoteRefusal | null {
  if (c.confirmed !== true) return 'NOT_CONFIRMED';
  if (typeof c.submissionNonce !== 'string' || !PROMOTE_SUBMISSION_NONCE.test(c.submissionNonce)) return 'INVALID_INPUT';
  const title = c.title.trim();
  const outcome = c.outcome.trim();
  if (title === '' || [...title].length > PROMOTE_TITLE_MAX_CHARS) return 'INVALID_INPUT';
  if (outcome === '' || [...outcome].length > PROMOTE_OUTCOME_MAX_CHARS) return 'INVALID_INPUT';
  if (c.targetAt !== null && Number.isNaN(c.targetAt.getTime())) return 'INVALID_INPUT';
  return null;
}
