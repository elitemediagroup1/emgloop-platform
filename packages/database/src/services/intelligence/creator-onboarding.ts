// When EMG starts representing a creator, Loop looks -- unprompted -- at which brands the business
// already works with, who the contacts are, and what happened the last times it suggested them.
//
// THE TRIGGER IS A REAL EVENT FROM A REAL AUTHORITY. There is no Creator Hub yet, and nothing here
// pretends there is. "EMG now represents this person" is already a governed CRM fact: a
// `TALENT_REPRESENTATION` Relationship becoming ACTIVE, which `CrmRelationshipService` publishes to
// the one outbox. That is the trigger today. When Creator Hub exists it publishes its own
// `CreatorOnboarded` event (domain CREATOR, subject the creator's Party) and the same review runs;
// Creator Hub owns creator onboarding, and this file never decides who is a creator.
//
// WHAT IT READS -- AUTHORITIES THAT ALREADY EXIST, NOTHING INFERRED:
//   - the organization's CLIENT Relationships (CRM: a human asserted each one), ACTIVE first;
//   - their active participants in an engagement role (CRM: the known contacts);
//   - earlier creator-onboarding Cases and the outcomes people recorded on them (Decision Engine).
// It does not match names, does not compare categories, and does not claim a creator FITS a brand:
// it says which relationships are worth a person's review, and why, with the record for each.
//
// WHAT IT WRITES: at most one Case per creator, through the Decision Engine as the SYSTEM producer
// it is -- keyed by the creator (recurrence) and the event (detection), so a redelivered event
// records nothing twice. No outreach, no message, no work item, no relationship: a person decides.
//
// NO REASON TO ACT, NO CASE. With no brand relationship to review, it records nothing and says so.
//
// RELEVANCE IS EVIDENCE FROM THE AUTHORITY THAT OWNS IT, OR IT IS ABSENT. Whether a creator suits a
// brand depends on creator context -- category, audience -- that Creator Hub will own and nothing
// owns today. The review therefore accepts relevance as an optional dependency
// (`CreatorRelevanceSource`) and cites what it returns as that authority's statement, with its
// CREATOR_HUB references, next to the relationship memory and the prior outcomes. With no source
// wired -- today -- it claims no fit at all. When Creator Hub exists, the path is: onboarded ->
// its authoritative creator context -> this relationship memory -> its relevance evidence ->
// prior brand, contact and outcome history -> surfaced. Nothing here changes shape for that.
import type { StateChangeOutbox } from '@prisma/client';
import { crmCanonicalPartyId, learnFromHistory, outcomeWords, type IntelligenceEvidenceRef, type IntelligenceSubjectRef, type PriorOutcome } from '@emgloop/shared';
import type { CrmRelationshipReadModelRepository } from '../../repositories/crm-relationship-read-model.repository';
import type { PartyReadModelRepository } from '../../repositories/party-read-model.repository';
import type { DecisionEngine } from '../decision/decision-engine';

export const CREATOR_ONBOARDING_PRODUCER = 'creator-onboarding';
export const CREATOR_ONBOARDING_VERSION = 'creator-onboarding.v1';
/** The Creator Hub event this review also accepts, once that authority exists. */
export const CREATOR_ONBOARDED_EVENT = 'CreatorOnboarded';
/** Brand relationships reviewed per creator. A shortlist, not a directory. */
export const CREATOR_REVIEW_BRAND_LIMIT = 5;

const ENGAGEMENT_ROLES: readonly string[] = ['PRIMARY_CONTACT', 'DECISION_MAKER', 'BILLING_CONTACT'];

/** What the creator-context authority says about one creator and one brand. Its words, its records. */
export interface CreatorRelevanceEvidence {
  readonly brandPartyId: string;
  /** The authority's own statement, cited as written. Loop does not rewrite it into a verdict. */
  readonly statement: string;
  /** The records it rests on. Only CREATOR_HUB references are accepted; anything else is dropped. */
  readonly refs: readonly IntelligenceEvidenceRef[];
}

/**
 * The seam Creator Hub fills. Given a creator and the brand relationships under review, return the
 * relevance evidence it holds -- or nothing. No implementation exists today, and none may be a
 * guess from names, categories typed into CRM notes, or anything else Loop does not own.
 */
export interface CreatorRelevanceSource {
  relevanceFor(organizationId: string, creatorPartyId: string, brandPartyIds: readonly string[]): Promise<readonly CreatorRelevanceEvidence[]>;
}

export interface CreatorOnboardingDeps {
  readonly relationships: Pick<CrmRelationshipReadModelRepository, 'list' | 'getRecord'>;
  readonly parties: Pick<PartyReadModelRepository, 'getRecord'>;
  readonly cases: Pick<DecisionEngine, 'create' | 'list' | 'getHistory'>;
  /** Absent until Creator Hub owns creator context. Without it, no fit is claimed. */
  readonly relevance?: CreatorRelevanceSource;
}

export interface CreatorOnboardingResult {
  readonly status: 'ok' | 'noop';
  readonly summary: string;
}

/**
 * Which creator an outbox event is about, if it means "EMG now represents this person".
 * Anything else -- another kind, another transition, another domain -- is not this review's business.
 */
export async function onboardedCreator(
  organizationId: string,
  outbox: Pick<StateChangeOutbox, 'domain' | 'eventType' | 'subjectId' | 'payload'>,
  relationships: Pick<CrmRelationshipReadModelRepository, 'getRecord'>,
): Promise<{ readonly creatorPartyId: string; readonly relationshipId: string | null } | null> {
  if (outbox.domain === 'CREATOR' && outbox.eventType === CREATOR_ONBOARDED_EVENT && outbox.subjectId) {
    return { creatorPartyId: outbox.subjectId, relationshipId: null };
  }
  if (outbox.domain !== 'RELATIONSHIP') return null;
  const payload = (outbox.payload ?? {}) as { relationshipId?: unknown; kind?: unknown; fromState?: unknown; toState?: unknown };
  if (payload.kind !== 'TALENT_REPRESENTATION' || payload.toState !== 'ACTIVE' || payload.fromState === 'ACTIVE') return null;
  if (typeof payload.relationshipId !== 'string') return null;
  // The creator is the represented side, read from the Relationship itself -- never from a payload.
  const record = await relationships.getRecord(organizationId, payload.relationshipId);
  if (!record || record.kind !== 'TALENT_REPRESENTATION' || record.state !== 'ACTIVE') return null;
  const side = record.sides.find((s) => s.side === 'COUNTERPARTY');
  const creatorPartyId = side ? crmCanonicalPartyId(side.party) : null;
  return creatorPartyId ? { creatorPartyId, relationshipId: record.relationshipId } : null;
}

/** Brand Party ids an earlier creator-onboarding Case put in front of a person, with its outcome. */
async function earlierSuggestions(organizationId: string, cases: CreatorOnboardingDeps['cases']): Promise<{ brandPartyId: string; prior: PriorOutcome }[]> {
  const earlier = (await cases.list(organizationId, { producer: CREATOR_ONBOARDING_PRODUCER, take: 100 })).filter((c) => c.outcome !== null);
  const out: { brandPartyId: string; prior: PriorOutcome }[] = [];
  for (const c of earlier.slice(0, 25)) {
    const log = await cases.getHistory(organizationId, c.id);
    const opening = log.find((o) => o.observationType === 'SITUATION_DETECTED');
    const related = ((opening?.evidence ?? {}) as { intelligence?: { related?: IntelligenceSubjectRef[] } }).intelligence?.related ?? [];
    const closing = [...log].reverse().find((o) => o.outcome !== null);
    for (const brand of related.filter((r) => r.kind === 'BRAND')) {
      out.push({
        brandPartyId: brand.ref,
        prior: { at: closing?.occurredAt ?? c.updatedAt, outcome: c.outcome!, reason: closing?.reason ?? null, relation: 'COMPARABLE', subjectLabel: brand.label },
      });
    }
  }
  return out;
}

export async function reviewOnboardedCreator(
  organizationId: string,
  trigger: { readonly creatorPartyId: string; readonly relationshipId: string | null; readonly eventId: string },
  deps: CreatorOnboardingDeps,
  now: Date,
): Promise<CreatorOnboardingResult> {
  const creator = await deps.parties.getRecord(organizationId, trigger.creatorPartyId);
  if (!creator) return { status: 'noop', summary: 'the creator is not a Party in this organization' };

  // CLIENT Relationships (EMG works with this company), ACTIVE before ENDED, newest first.
  const page = await deps.relationships.list(organizationId, { limit: 100 });
  const clients = page.items
    .filter((r) => r.kind === 'CLIENT' && (r.state === 'ACTIVE' || r.state === 'ENDED'))
    .sort((a, b) => (a.state === b.state ? b.createdAt.localeCompare(a.createdAt) : a.state === 'ACTIVE' ? -1 : 1))
    .slice(0, CREATOR_REVIEW_BRAND_LIMIT);
  if (clients.length === 0) return { status: 'noop', summary: 'no brand relationship to review' };

  const history = await earlierSuggestions(organizationId, deps.cases);
  const brandIds = clients
    .map((client) => client.sides.find((side) => side.side === 'COUNTERPARTY'))
    .map((side) => (side ? crmCanonicalPartyId(side.party) : null))
    .filter((id): id is string => id !== null);
  const relevance = deps.relevance ? await deps.relevance.relevanceFor(organizationId, trigger.creatorPartyId, brandIds) : [];
  const refs: IntelligenceEvidenceRef[] = [];
  const related: IntelligenceSubjectRef[] = [{ kind: 'CREATOR', ref: trigger.creatorPartyId, label: creator.displayName ?? null, verified: true }];
  const remembers: string[] = [];
  const previously: PriorOutcome[] = [];
  const lines: string[] = [];
  for (const client of clients) {
    const brandSide = client.sides.find((s) => s.side === 'COUNTERPARTY');
    const brandPartyId = brandSide ? crmCanonicalPartyId(brandSide.party) : null;
    if (!brandPartyId) continue;
    const brand = await deps.parties.getRecord(organizationId, brandPartyId);
    const brandName = brand?.displayName ?? 'A client';
    refs.push({ authority: 'CRM', kind: 'RELATIONSHIP', ref: client.relationshipId, label: `${client.kindLabel} · ${client.state}`, observedAt: new Date(client.createdAt) });
    related.push({ kind: 'BRAND', ref: brandPartyId, label: brandName, verified: true });

    const record = await deps.relationships.getRecord(organizationId, client.relationshipId);
    const contacts = (record?.participants ?? []).filter((p) => p.state === 'ACTIVE' && ENGAGEMENT_ROLES.includes(p.role));
    const contactNames: string[] = [];
    for (const contact of contacts.slice(0, 2)) {
      const id = crmCanonicalPartyId(contact.party);
      if (!id) continue;
      const person = await deps.parties.getRecord(organizationId, id);
      related.push({ kind: 'CONTACT', ref: id, label: person?.displayName ?? null, verified: true });
      if (person?.displayName) contactNames.push(`${person.displayName} (${contact.role.toLowerCase().replace(/_/g, ' ')})`);
    }

    // Relevance, only as the owning authority stated it and only with its own records.
    const stated = relevance.find((r) => r.brandPartyId === brandPartyId && r.statement.trim() !== '');
    const statedRefs = (stated?.refs ?? []).filter((r) => r.authority === 'CREATOR_HUB');
    refs.push(...statedRefs);
    const statedLine = stated && statedRefs.length > 0 ? ` Creator Hub: ${stated.statement.trim()}` : '';

    const before = history.filter((h) => h.brandPartyId === brandPartyId).map((h) => h.prior);
    previously.push(...before);
    const last = [...before].sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    const standing = client.state === 'ACTIVE' ? 'an active client relationship' : 'a past client relationship (ended)';
    lines.push(
      `${brandName}: EMG has ${standing}.` +
        (contactNames.length ? ` Known contact: ${contactNames.join(', ')}.` : ' No contact is recorded on it.') +
        statedLine +
        (last ? ` Last time Loop suggested ${brandName} for a new creator, it ${outcomeWords(last.outcome)}.` : ''),
    );
    if (last) remembers.push(`${brandName} was suggested for a new creator before; it ${outcomeWords(last.outcome)}.`);
  }
  if (lines.length === 0) return { status: 'noop', summary: 'no brand relationship with an established Party' };

  const learned = learnFromHistory(previously, { posture: 'REVIEW', text: 'Review which of these brand relationships to raise with the creator.' });
  const result = await deps.cases.create(organizationId, {
    producer: CREATOR_ONBOARDING_PRODUCER,
    producerVersion: CREATOR_ONBOARDING_VERSION,
    recurrenceKey: `creator-onboarding::${trigger.creatorPartyId}`,
    detectionKey: `outbox:${trigger.eventId}`,
    detectedAt: now,
    title: `${creator.displayName ?? 'A new creator'}: ${lines.length} brand relationship${lines.length === 1 ? '' : 's'} worth reviewing`,
    summary: lines.join('\n'),
    severity: 'NOTABLE',
    sourceReference: trigger.relationshipId ?? trigger.creatorPartyId,
    // The opening picture, kept verbatim: which records this rests on, who it concerns, what Loop
    // remembered and how that changed the suggestion. Evidence rows are for measurements and human
    // reports; these are references to records other authorities own, and they stay theirs.
    evidenceSnapshot: {
      intelligence: {
        refs: refs.map((r) => ({ ...r, observedAt: r.observedAt?.toISOString() ?? null })),
        related,
        remembers,
        previously: previously.map((p) => ({ ...p, at: p.at.toISOString() })),
        suggestedReview: learned,
      },
    },
  });
  return { status: 'ok', summary: `creator review ${result.effect.toLowerCase()} with ${lines.length} brand relationship(s)` };
}
