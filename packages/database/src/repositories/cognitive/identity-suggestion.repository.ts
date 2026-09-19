// Identity match suggestions: persisted, never verified truth (D1, approved 2026-09-19).
//
// A suggestion says "this correspondent may be that established Party", rests on exact evidence,
// and waits for a person. It is a BELIEF, so it lives on the one belief authority,
// `intelligence_hypotheses` (created PROPOSED, decided only by an attributed person), with the
// columns D1 added. There is no second suggestion store and no new identity authority: a
// confirmed suggestion writes no IdentityEvidence, no resolution link, no CustomerPartyLink and no
// Party. It is a person's confirmed reading of their own evidence.
//
// PRIVATE BY CONSTRUCTION. Every suggestion today rests on one person's own mail, so every method
// takes that person's principal, and a row belongs to exactly one member (`privateToUserId`, with
// a composite key to their membership). Nobody else reads it -- not an OWNER, not an admin, not
// the organization-wide hypothesis reads, which skip private rows. It is erased with the person's
// work state. Promotion to organization scope needs an explicit governed authority, and none
// exists yet; nothing here provides one.
//
// REMEMBERED. The match key (scope, the subject's one-way key, the Party) and the fingerprint of
// the exact evidence used are unique together. The same evidence can produce the same suggestion
// once, ever: once rejected, it is never proposed again from that evidence. Different evidence --
// another identifier record, or a new one after the old was revoked -- is a new fingerprint, and
// a new PROPOSED row that names the rejections it reconsiders. The rejected rows stay as they are.
//
// REFERENCES, NOT COPIES. The evidence stays with the authority that owns it: the correspondent in
// the person's own graph (by its one-way key) and the identifier record on the Party (by id). This
// row stores those references with the method, the reason, the source and the time. It never
// stores an address, a name or any other contact value.
//
// DECIDED ELSEWHERE. `decide` is a conditional write used only by `IdentitySuggestionService`,
// which authorizes the person under the identity authority first. Nothing here checks authority.

import { createHash } from 'crypto';
import type { IntelligenceHypothesis, Prisma, PrismaClient } from '@prisma/client';

import type { WorkPrincipal } from '../work-state/work-principal';

export const IDENTITY_MATCH_TYPE = 'IDENTITY_MATCH';
/** The one rule that proposes today: an exact email key. Name similarity is not a rule here. */
export const IDENTITY_MATCH_RULE_VERSION = 'identity-match.exact-email.v1';

export type IdentitySuggestionStatus = 'PROPOSED' | 'CONFIRMED' | 'REJECTED';

export interface IdentitySuggestionEvidenceRef {
  /** GMAIL: the person's own correspondent, by one-way key. IDENTITY: an identifier record on a Party. */
  readonly authority: 'GMAIL' | 'IDENTITY';
  readonly kind: 'CORRESPONDENT' | 'IDENTITY_EVIDENCE';
  readonly ref: string;
  readonly observedAt: string | null;
}

/** What a suggestion rests on, as stored: references, method, reason, source and time. */
export interface IdentitySuggestionBasis {
  readonly method: 'EXACT_EMAIL_KEY';
  readonly source: 'GMAIL';
  readonly reason: string;
  readonly observedAt: string;
  readonly refs: readonly IdentitySuggestionEvidenceRef[];
  /** Earlier REJECTED suggestions of this same match that new evidence reopens. They stay rejected. */
  readonly reconsiders: readonly string[];
}

export interface IdentitySuggestion {
  readonly id: string;
  readonly scope: 'PRIVATE';
  readonly ownerUserId: string;
  /** The correspondent's one-way key in the owner's own graph. */
  readonly subjectKey: string;
  readonly partyId: string;
  readonly status: IdentitySuggestionStatus;
  readonly basis: IdentitySuggestionBasis;
  readonly ruleVersion: string | null;
  readonly proposedAt: Date;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
}

export interface ProposeIdentitySuggestion {
  readonly subjectKey: string;
  readonly partyId: string;
  /** The identifier records on the Party that matched. At least one. */
  readonly identityEvidence: readonly { readonly id: string; readonly observedAt: Date | null }[];
  readonly reason: string;
  readonly observedAt: Date;
}

/**
 * PROPOSED: first suggestion of this match. RECONSIDERED: proposed again on new evidence after a
 * rejection. UNCHANGED: this exact evidence already produced it (whatever became of it).
 * STANDING: this match is already pending or confirmed; new evidence does not duplicate it.
 */
export type ProposeOutcome = 'PROPOSED' | 'RECONSIDERED' | 'UNCHANGED' | 'STANDING';

const STATUS: Readonly<Record<string, IdentitySuggestionStatus>> = { PROPOSED: 'PROPOSED', ACCEPTED: 'CONFIRMED', REJECTED: 'REJECTED' };

export function identityMatchKey(principal: WorkPrincipal, subjectKey: string, partyId: string): string {
  return `${IDENTITY_MATCH_TYPE}:user:${principal.userId}:correspondent:${subjectKey}:party:${partyId}`;
}

/** One-way fingerprint of the exact evidence records. Re-seeing them later is not new evidence. */
export function identityEvidenceFingerprint(refs: readonly IdentitySuggestionEvidenceRef[]): string {
  const lines = refs.map((r) => `${r.authority}:${r.kind}:${r.ref}`).sort();
  return createHash('sha256').update([IDENTITY_MATCH_RULE_VERSION, ...lines].join('\n')).digest('hex');
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

export function toIdentitySuggestion(row: IntelligenceHypothesis): IdentitySuggestion | null {
  const status = STATUS[row.status];
  const basis = row.evidenceRefs as unknown as IdentitySuggestionBasis | null;
  const subject = basis?.refs.find((r) => r.authority === 'GMAIL' && r.kind === 'CORRESPONDENT');
  if (!status || !basis || !subject || !row.privateToUserId || !row.subjectIdentityId) return null;
  const confirmed = status === 'CONFIRMED';
  return {
    id: row.id,
    scope: 'PRIVATE',
    ownerUserId: row.privateToUserId,
    subjectKey: subject.ref,
    partyId: row.subjectIdentityId,
    status,
    basis,
    ruleVersion: row.ruleVersion,
    proposedAt: row.createdAt,
    decidedAt: confirmed ? row.acceptedAt : status === 'REJECTED' ? row.rejectedAt : null,
    decidedBy: confirmed ? row.acceptedBy : status === 'REJECTED' ? row.rejectedBy : null,
    decisionReason: row.decisionReason,
  };
}

export class IdentitySuggestionRepository {
  constructor(private readonly db: PrismaClient | Prisma.TransactionClient) {}

  private owned(principal: WorkPrincipal) {
    return { organizationId: principal.organizationId, privateToUserId: principal.userId, hypothesisType: IDENTITY_MATCH_TYPE };
  }

  /**
   * Record a suggestion for this person, unless this exact evidence already produced it or the
   * match is already pending or confirmed. Always PROPOSED; there is no other way in.
   */
  async propose(principal: WorkPrincipal, input: ProposeIdentitySuggestion): Promise<ProposeOutcome> {
    if (input.identityEvidence.length === 0) throw new Error('an identity suggestion needs the identifier evidence it rests on');
    const refs: IdentitySuggestionEvidenceRef[] = [
      { authority: 'GMAIL', kind: 'CORRESPONDENT', ref: input.subjectKey, observedAt: input.observedAt.toISOString() },
      ...input.identityEvidence.map((e) => ({ authority: 'IDENTITY' as const, kind: 'IDENTITY_EVIDENCE' as const, ref: e.id, observedAt: e.observedAt?.toISOString() ?? null })),
    ];
    const matchKey = identityMatchKey(principal, input.subjectKey, input.partyId);
    const evidenceFingerprint = identityEvidenceFingerprint(refs);
    const earlier = await this.db.intelligenceHypothesis.findMany({
      where: { ...this.owned(principal), matchKey },
      select: { id: true, status: true, evidenceFingerprint: true },
      orderBy: { createdAt: 'asc' },
    });
    if (earlier.some((row) => row.evidenceFingerprint === evidenceFingerprint)) return 'UNCHANGED';
    if (earlier.some((row) => row.status === 'PROPOSED' || row.status === 'ACCEPTED')) return 'STANDING';
    const reconsiders = earlier.filter((row) => row.status === 'REJECTED').map((row) => row.id);
    const basis: IdentitySuggestionBasis = { method: 'EXACT_EMAIL_KEY', source: 'GMAIL', reason: input.reason, observedAt: input.observedAt.toISOString(), refs, reconsiders };
    try {
      await this.db.intelligenceHypothesis.create({
        data: {
          organizationId: principal.organizationId,
          privateToUserId: principal.userId,
          hypothesisType: IDENTITY_MATCH_TYPE,
          subjectIdentityId: input.partyId,
          title: 'Possible match: a correspondent and an established Party',
          summary: input.reason,
          status: 'PROPOSED',
          evidenceCount: input.identityEvidence.length,
          supportingWindowEnd: input.observedAt,
          scope: 'INDIVIDUAL',
          sensitivity: 'CONFIDENTIAL',
          permittedPurposes: [],
          generatedBy: 'DETERMINISTIC_RULE',
          ruleVersion: IDENTITY_MATCH_RULE_VERSION,
          matchKey,
          evidenceFingerprint,
          evidenceRefs: basis as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // A concurrent read proposed the same thing first. That is the same outcome, not an error.
      if (isUniqueViolation(err)) return 'UNCHANGED';
      throw err;
    }
    return reconsiders.length > 0 ? 'RECONSIDERED' : 'PROPOSED';
  }

  /** One of this person's own suggestions. Anybody else's is not found. */
  async find(principal: WorkPrincipal, id: string): Promise<IdentitySuggestion | null> {
    const row = await this.db.intelligenceHypothesis.findFirst({ where: { ...this.owned(principal), id } });
    return row ? toIdentitySuggestion(row) : null;
  }

  /** This person's suggestions in the given states, newest first. */
  async forOwner(principal: WorkPrincipal, statuses: readonly IdentitySuggestionStatus[] = ['PROPOSED', 'CONFIRMED']): Promise<IdentitySuggestion[]> {
    const stored = statuses.map((s) => (s === 'CONFIRMED' ? 'ACCEPTED' : s));
    const rows = await this.db.intelligenceHypothesis.findMany({
      where: { ...this.owned(principal), status: { in: stored as IntelligenceHypothesis['status'][] } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map(toIdentitySuggestion).filter((s): s is IdentitySuggestion => s !== null);
  }

  /** Every suggestion ever made of one match, oldest first: the history a rejection leaves. */
  async history(principal: WorkPrincipal, subjectKey: string, partyId: string): Promise<IdentitySuggestion[]> {
    const rows = await this.db.intelligenceHypothesis.findMany({
      where: { ...this.owned(principal), matchKey: identityMatchKey(principal, subjectKey, partyId) },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toIdentitySuggestion).filter((s): s is IdentitySuggestion => s !== null);
  }

  /**
   * Record a person's decision on a PROPOSED suggestion of their own. Conditional on it still
   * being PROPOSED, so a decision is made once. The caller has already authorized the person.
   */
  async decide(
    principal: WorkPrincipal,
    id: string,
    decision: { readonly verdict: 'CONFIRM' | 'REJECT'; readonly reason: string | null; readonly at: Date },
  ): Promise<boolean> {
    const data =
      decision.verdict === 'CONFIRM'
        ? { status: 'ACCEPTED' as const, acceptedBy: principal.userId, acceptedAt: decision.at, decisionReason: decision.reason }
        : { status: 'REJECTED' as const, rejectedBy: principal.userId, rejectedAt: decision.at, decisionReason: decision.reason };
    const done = await this.db.intelligenceHypothesis.updateMany({ where: { ...this.owned(principal), id, status: 'PROPOSED' }, data });
    return done.count === 1;
  }

  /** Delete every suggestion resting on this person's private evidence. How many went; never a row. */
  async erasePrivate(principal: WorkPrincipal): Promise<{ readonly suggestions: number }> {
    const done = await this.db.intelligenceHypothesis.deleteMany({
      where: { organizationId: principal.organizationId, privateToUserId: principal.userId },
    });
    return { suggestions: done.count };
  }
}
