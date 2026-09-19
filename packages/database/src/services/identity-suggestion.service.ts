// IdentitySuggestionService -- a person confirms or rejects a machine identity suggestion (D1).
//
// THE ONLY WAY A SUGGESTION IS DECIDED. A detector proposes (always PROPOSED, never anything else);
// only this service moves a suggestion on, and only for an attributed person acting under the
// existing identity authority:
//
//   confirm / reject   identityResolution:update  -- OWNER, ADMIN, MANAGER (identity record §6,
//                                                     "Confirm / reject an attribution")
//
// plus `employeeIntelligence:view`, because the suggestion rests on the person's own private
// evidence. AI_EMPLOYEE holds neither, by hard denial that no Permission row can lift, and a
// system actor has no membership to hold them with -- so no machine principal can ever turn a
// PROPOSED suggestion into a confirmed one. There is no new grant.
//
// PRIVATE, AND ONLY THE OWNER'S. A suggestion from someone's own mail is theirs alone: anybody
// else -- an OWNER included -- gets NOT_FOUND, indistinguishable from a suggestion that does not
// exist. Authority is checked before anything is read, so a person without it learns nothing.
//
// WHAT A CONFIRMATION IS, AND IS NOT. It records that this person, looking at their own evidence,
// says the correspondent is that Party. From then on the person's own intelligence may use the
// match as verified. It writes no IdentityEvidence, no resolution link, no CustomerPartyLink, no
// Party and no Relationship, and it never reaches organization scope: promoting a private match
// needs a governed authority that does not exist yet.
//
// REJECTION IS REMEMBERED. A rejected suggestion keeps its evidence fingerprint, so the same
// evidence never proposes it again (`IdentitySuggestionRepository.propose`). A reason is required
// (identity record §13). The reason is kept on the person's private row, which is erased with
// their work state.
//
// AUDITED WITHOUT CONTENT. The trail records the act, the person and the rule -- never the Party,
// the correspondent key or the reason, which would carry private evidence into an
// organization-readable log.

import type { PrismaClient } from '@prisma/client';

import { AuditRepository } from '../repositories/audit.repository';
import { IamRepository } from '../repositories/iam.repository';
import { PartyReferenceRepository } from '../repositories/party-reference.repository';
import { IdentitySuggestionRepository, type IdentitySuggestion } from '../repositories/cognitive/identity-suggestion.repository';

export const IDENTITY_SUGGESTION_CONFIRMED_AUDIT_ACTION = 'identity_suggestion.confirmed';
export const IDENTITY_SUGGESTION_REJECTED_AUDIT_ACTION = 'identity_suggestion.rejected';
const REASON_MAX = 500;

/** The person acting. Both ids come from the signed session, never from a request body. */
export interface IdentitySuggestionActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly actorName?: string | null;
}

export type IdentitySuggestionDecision =
  | { readonly outcome: 'CONFIRMED' | 'REJECTED'; readonly suggestion: IdentitySuggestion }
  | { readonly outcome: 'ALREADY_DECIDED'; readonly suggestion: IdentitySuggestion }
  | { readonly outcome: 'PARTY_NOT_REFERENCEABLE'; readonly canonicalPartyId: string | null }
  | { readonly outcome: 'NOT_AUTHORIZED' | 'NOT_FOUND' | 'REASON_REQUIRED' | 'INVALID' };

export interface IdentitySuggestionServiceDeps {
  iam?: Pick<IamRepository, 'can'>;
  suggestions?: IdentitySuggestionRepository;
  parties?: Pick<PartyReferenceRepository, 'requireReferenceable'>;
  audit?: Pick<AuditRepository, 'record'>;
  now?: () => Date;
}

export class IdentitySuggestionService {
  private readonly iam: Pick<IamRepository, 'can'>;
  private readonly suggestions: IdentitySuggestionRepository;
  private readonly parties: Pick<PartyReferenceRepository, 'requireReferenceable'>;
  private readonly audit: Pick<AuditRepository, 'record'>;
  private readonly now: () => Date;

  constructor(prisma: PrismaClient, deps: IdentitySuggestionServiceDeps = {}) {
    this.iam = deps.iam ?? new IamRepository(prisma);
    this.suggestions = deps.suggestions ?? new IdentitySuggestionRepository(prisma);
    this.parties = deps.parties ?? new PartyReferenceRepository(prisma);
    this.audit = deps.audit ?? new AuditRepository(prisma);
    this.now = deps.now ?? (() => new Date());
  }

  /** The question every decision asks first, for a surface deciding whether to offer one. */
  async canDecide(actor: IdentitySuggestionActor): Promise<boolean> {
    if (!validActor(actor)) return false;
    const scope = { organizationId: actor.organizationId, userId: actor.userId };
    return (
      (await this.iam.can({ ...scope, resource: 'identityResolution', action: 'update' })) &&
      (await this.iam.can({ ...scope, resource: 'employeeIntelligence', action: 'view' }))
    );
  }

  confirm(actor: IdentitySuggestionActor, suggestionId: string, reason: string | null = null): Promise<IdentitySuggestionDecision> {
    return this.decide(actor, suggestionId, 'CONFIRM', reason);
  }

  reject(actor: IdentitySuggestionActor, suggestionId: string, reason: string): Promise<IdentitySuggestionDecision> {
    return this.decide(actor, suggestionId, 'REJECT', reason);
  }

  private async decide(
    actor: IdentitySuggestionActor,
    suggestionId: string,
    verdict: 'CONFIRM' | 'REJECT',
    reason: string | null,
  ): Promise<IdentitySuggestionDecision> {
    if (!validActor(actor) || typeof suggestionId !== 'string' || suggestionId.trim() === '') return { outcome: 'INVALID' };
    const words = typeof reason === 'string' ? reason.trim().slice(0, REASON_MAX) : '';
    if (verdict === 'REJECT' && words === '') return { outcome: 'REASON_REQUIRED' };
    if (!(await this.canDecide(actor))) return { outcome: 'NOT_AUTHORIZED' };

    const principal = { organizationId: actor.organizationId, userId: actor.userId };
    const suggestion = await this.suggestions.find(principal, suggestionId);
    if (!suggestion) return { outcome: 'NOT_FOUND' };
    if (suggestion.status !== 'PROPOSED') return { outcome: 'ALREADY_DECIDED', suggestion };

    if (verdict === 'CONFIRM') {
      // A confirmation names a Party, so it follows the Party Reference contract: an archived or
      // superseded Party is refused with its canonical id, never silently substituted.
      const party = await this.parties.requireReferenceable(actor.organizationId, suggestion.partyId);
      if (!party.ok) {
        const canonical = party.resolution.state === 'SUPERSEDED' ? party.resolution.canonicalPartyId : null;
        return { outcome: 'PARTY_NOT_REFERENCEABLE', canonicalPartyId: canonical };
      }
    }

    const decided = await this.suggestions.decide(principal, suggestion.id, { verdict, reason: words === '' ? null : words, at: this.now() });
    const after = await this.suggestions.find(principal, suggestion.id);
    // Somebody (this same person, in another tab) decided it first: their decision stands, and
    // no audit entry is written for a write that did not happen.
    if (!decided || !after) return after ? { outcome: 'ALREADY_DECIDED', suggestion: after } : { outcome: 'NOT_FOUND' };

    await this.audit.record({
      organizationId: actor.organizationId,
      userId: actor.userId,
      actorName: typeof actor.actorName === 'string' && actor.actorName.trim() !== '' ? actor.actorName.trim() : undefined,
      action: verdict === 'CONFIRM' ? IDENTITY_SUGGESTION_CONFIRMED_AUDIT_ACTION : IDENTITY_SUGGESTION_REJECTED_AUDIT_ACTION,
      entityType: 'identity_suggestion',
      entityId: suggestion.id,
      metadata: { scope: 'PRIVATE', ruleVersion: suggestion.ruleVersion },
    });
    return { outcome: verdict === 'CONFIRM' ? 'CONFIRMED' : 'REJECTED', suggestion: after };
  }
}

function validActor(actor: IdentitySuggestionActor): boolean {
  return (
    typeof actor?.organizationId === 'string' && actor.organizationId.trim() !== '' && typeof actor.userId === 'string' && actor.userId.trim() !== ''
  );
}
