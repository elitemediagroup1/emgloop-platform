// Machine identity suggestions from a person's own mail (D1, approved 2026-09-19). PROPOSE ONLY.
//
// After a Gmail read, each of the person's correspondents is checked against the identifiers the
// organization has recorded on its established Parties. The check is EXACT: the correspondent's
// address is reduced to the organization-salted key identity evidence is stored under
// (`hashIdentifier`), and only an equal key on an active, unexpired EMAIL identifier counts. No
// name, no domain, no similarity -- a name alone is WEAK and never proposes (identity record §5).
//
// WHAT IT PROPOSES, AND WHEN IT DOES NOT:
//   - exactly one established, referenceable Party carries the key -> one PROPOSED suggestion,
//     private to this person, citing the correspondent and the identifier records;
//   - two or more Parties carry it -> CONFLICTING: nothing is proposed, a person decides (§8);
//   - the Party is superseded, archived or not established -> nothing (Party Reference contract);
//   - the same evidence already produced this suggestion -> nothing, whatever became of it, so a
//     rejection holds until the evidence itself changes.
// It never confirms, rejects, links, establishes or writes identity evidence. A person decides,
// through `IdentitySuggestionService`, under the identity authority.
//
// ONLY FOR SOMEONE WHO CAN DECIDE. A suggestion is private to the person whose mail it came from,
// so if they cannot confirm or reject an attribution (identityResolution:update), nobody can: the
// detector proposes nothing for them rather than leaving a question nobody may answer.
//
// NOTHING HASHED WITHOUT A REASON, OR WITH THE WRONG KEY. When the organization has recorded no
// EMAIL identifier on any Party, the detector stops before reading a single correspondent. When the
// identifier key is not configured where it runs, it stops too and reports `keyUnavailable`:
// hashing with the development fallback could never match evidence recorded under the real key,
// and "found nothing" would be a false statement.
//
// COUNTS ONLY. The result is how many were checked, proposed, conflicting or unchanged -- never an
// address, a key, a name or a Party.
import type { PrismaClient } from '@prisma/client';
import { hashIdentifier, identifierKeyConfigured } from '../../repositories/cognitive/hashing';
import { IdentitySuggestionRepository } from '../../repositories/cognitive/identity-suggestion.repository';
import { IamRepository } from '../../repositories/iam.repository';
import { PartyReferenceRepository } from '../../repositories/party-reference.repository';
import { WorkGraphRepository } from '../../repositories/work-state/work-graph.repository';
import type { SourceReadDetector } from './source-read';

/** Correspondents checked per read: the same bound the person's own graph reads use. */
export const IDENTITY_SUGGESTION_CORRESPONDENT_LIMIT = 500;

export function identitySuggestionDetector(prisma: PrismaClient): SourceReadDetector {
  return {
    id: 'identity-suggestions',
    sources: ['GMAIL'],
    scope: 'PRIVATE',
    async detect(event): Promise<Readonly<Record<string, number>>> {
      const principal = { organizationId: event.organizationId, userId: event.userId! };
      const counts = { checked: 0, matched: 0, proposed: 0, reconsidered: 0, unchanged: 0, standing: 0, conflicting: 0, notReferenceable: 0 };

      const iam = new IamRepository(prisma);
      const canDecide =
        (await iam.can({ ...principal, resource: 'identityResolution', action: 'update' })) &&
        (await iam.can({ ...principal, resource: 'employeeIntelligence', action: 'view' }));
      if (!canDecide) return { notEligible: 1 };

      const anyIdentifier = await prisma.identityEvidence.findFirst({
        where: { organizationId: event.organizationId, evidenceType: 'EMAIL', revokedAt: null },
        select: { id: true },
      });
      if (!anyIdentifier) return counts;
      if (!identifierKeyConfigured()) return { ...counts, keyUnavailable: 1 };

      const people = await new WorkGraphRepository(prisma).correspondents(principal, { limit: IDENTITY_SUGGESTION_CORRESPONDENT_LIMIT });
      const byKey = new Map<string, string>();
      for (const person of people) {
        if (!person.displayAddress) continue;
        byKey.set(hashIdentifier(event.organizationId, 'EMAIL', person.displayAddress), person.addressHash);
      }
      counts.checked = byKey.size;
      if (byKey.size === 0) return counts;

      const records = (
        await prisma.identityEvidence.findMany({
          where: { organizationId: event.organizationId, evidenceType: 'EMAIL', revokedAt: null, normalizedValueHash: { in: [...byKey.keys()] } },
          select: { id: true, identityId: true, normalizedValueHash: true, observedAt: true, expiresAt: true },
        })
      ).filter((r) => r.expiresAt === null || r.expiresAt > event.completedAt);

      const bySubject = new Map<string, typeof records>();
      for (const record of records) {
        const subject = byKey.get(record.normalizedValueHash);
        if (subject) bySubject.set(subject, [...(bySubject.get(subject) ?? []), record]);
      }

      const parties = new PartyReferenceRepository(prisma);
      const suggestions = new IdentitySuggestionRepository(prisma);
      for (const [subjectKey, matched] of bySubject) {
        counts.matched += 1;
        const candidates = new Map<string, typeof records>();
        for (const identityId of new Set(matched.map((r) => r.identityId))) {
          // Only an established Party that may be referenced as itself: never a superseded one
          // silently swapped for its successor, an archived one, or a cognitive subject.
          const party = await parties.requireReferenceable(event.organizationId, identityId);
          if (party.ok && party.reference.partyId === identityId) candidates.set(identityId, matched.filter((r) => r.identityId === identityId));
        }
        if (candidates.size === 0) {
          counts.notReferenceable += 1;
          continue;
        }
        if (candidates.size > 1) {
          counts.conflicting += 1;
          continue;
        }
        const [[partyId, evidence]] = [...candidates] as [[string, typeof records]];
        const outcome = await suggestions.propose(principal, {
          subjectKey,
          partyId,
          identityEvidence: evidence.map((r) => ({ id: r.id, observedAt: r.observedAt })),
          reason: 'This correspondent’s address exactly matches an email identifier recorded on one established Party.',
          observedAt: event.completedAt,
        });
        if (outcome === 'PROPOSED') counts.proposed += 1;
        else if (outcome === 'RECONSIDERED') counts.reconsidered += 1;
        else if (outcome === 'STANDING') counts.standing += 1;
        else counts.unchanged += 1;
      }
      return counts;
    },
  };
}
