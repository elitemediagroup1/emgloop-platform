// Stage 3 — Identity resolution.
//
// Resolves a participating identity by permitted evidence, in strict precedence:
//   1. authenticated canonical identity
//   2. (explicit confirmed link — established out-of-band, honored via evidence)
//   3. verified email / phone
//   4. first-party session continuity
//   5. pseudonymous identifier (known canonicalKey)
//   6. create anonymous identity (stable derived key so reprocessing resolves
//      to the SAME identity — resolution is idempotent)
//
// Never merges on name similarity. Never resolves across organizations (every
// lookup is org-scoped through the repositories). Records the method and
// confidence; attaches evidence hints (idempotently) so future events resolve.

import type { CognitiveRepositories } from '../../repositories/cognitive';
import type { IdentityDescriptor } from './types';

export interface ResolutionResult {
  identityId: string;
  method: string;
  confidence: number;
}

/**
 * Resolve (or create) the identity for a descriptor. `stableKeyBase` is used
 * only as the last-resort anonymous key when the descriptor carries no session
 * or key of its own; callers pass something deterministic (e.g. the source
 * event id) so a retry of the same event does not spawn a second anonymous
 * identity.
 */
export async function resolveIdentity(
  organizationId: string,
  descriptor: IdentityDescriptor,
  repos: CognitiveRepositories,
  stableKeyBase: string,
): Promise<ResolutionResult> {
  // 1. Authenticated canonical identity (verified to exist in this org).
  if (descriptor.authenticatedIdentityId) {
    const found = await repos.identities.findById(organizationId, descriptor.authenticatedIdentityId);
    if (found) {
      await attach(organizationId, found.id, descriptor, repos);
      return { identityId: found.id, method: 'AUTHENTICATED', confidence: 1.0 };
    }
  }

  // 3. Verified email / phone.
  for (const hint of descriptor.evidence ?? []) {
    if (!hint.verified) continue;
    if (hint.evidenceType !== 'EMAIL' && hint.evidenceType !== 'PHONE') continue;
    const idId = await repos.identityEvidence.findIdentityIdByValue(
      organizationId,
      hint.evidenceType,
      hint.rawValue,
    );
    if (idId) {
      await attach(organizationId, idId, descriptor, repos);
      return {
        identityId: idId,
        method: hint.evidenceType === 'EMAIL' ? 'VERIFIED_EMAIL' : 'VERIFIED_PHONE',
        confidence: 0.9,
      };
    }
  }

  // 4. First-party session continuity.
  if (descriptor.sessionId) {
    const idId = await repos.identityEvidence.findIdentityIdByValue(
      organizationId,
      'SESSION_ID',
      descriptor.sessionId,
    );
    if (idId) {
      await attach(organizationId, idId, descriptor, repos);
      return { identityId: idId, method: 'SESSION_CONTINUITY', confidence: 0.7 };
    }
  }

  // 5. Pseudonymous known key.
  if (descriptor.canonicalKey) {
    const id = await repos.identities.resolveOrCreate(organizationId, {
      entityType: descriptor.entityType,
      canonicalKey: descriptor.canonicalKey,
      displayName: descriptor.displayName ?? null,
      status: 'KNOWN',
    });
    await attach(organizationId, id.id, descriptor, repos);
    return { identityId: id.id, method: 'PSEUDONYMOUS', confidence: 0.6 };
  }

  // 6. Create anonymous with a stable derived key (idempotent on reprocessing).
  const key = descriptor.sessionId ? `session:${descriptor.sessionId}` : stableKeyBase;
  const id = await repos.identities.resolveOrCreate(organizationId, {
    entityType: descriptor.entityType,
    canonicalKey: key,
    displayName: descriptor.displayName ?? null,
    status: 'ANONYMOUS',
  });
  await attach(organizationId, id.id, descriptor, repos);
  return {
    identityId: id.id,
    method: descriptor.sessionId ? 'SESSION_CONTINUITY' : 'PSEUDONYMOUS',
    confidence: 0.3,
  };
}

/**
 * Ensure the descriptor's role and evidence are attached to the identity —
 * idempotently, so a redelivered event does not create duplicate rows. Evidence
 * already resolving to this identity is skipped; the session id is recorded as
 * SESSION_ID evidence so subsequent events achieve continuity.
 */
async function attach(
  organizationId: string,
  identityId: string,
  descriptor: IdentityDescriptor,
  repos: CognitiveRepositories,
): Promise<void> {
  if (descriptor.roleType) {
    await repos.identityRoles.addRole(organizationId, { identityId, roleType: descriptor.roleType });
  }
  for (const hint of descriptor.evidence ?? []) {
    const existing = await repos.identityEvidence.findIdentityIdByValue(
      organizationId,
      hint.evidenceType,
      hint.rawValue,
    );
    if (existing === identityId) continue; // already attached
    await repos.identityEvidence.record(organizationId, {
      identityId,
      evidenceType: hint.evidenceType,
      rawValue: hint.rawValue,
      consentBasis: hint.consentBasis,
      permittedPurposes: hint.permittedPurposes,
    });
  }
  if (descriptor.sessionId) {
    const existing = await repos.identityEvidence.findIdentityIdByValue(
      organizationId,
      'SESSION_ID',
      descriptor.sessionId,
    );
    if (existing !== identityId) {
      await repos.identityEvidence.record(organizationId, {
        identityId,
        evidenceType: 'SESSION_ID',
        rawValue: descriptor.sessionId,
      });
    }
  }
}
