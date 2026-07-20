// Sprint 27B — Operational Readiness Engine: orchestration service (PR #121B)
// ---------------------------------------------------------------------------
// The thin bridge from a DERIVED readiness conclusion to the "who acts next"
// question, and no further. It:
//
//   1. runs the pure kernel (evaluateReadiness), then
//   2. for a suggested-handoff disposition, resolves the engine's next
//      RESPONSIBILITY KEY to a responsible PERSON via ResponsibilityRepository —
//      the "Responsibility → Assigned Person → Suggested Handoff" step — and
//      returns a SuggestedHandoff DESCRIPTOR.
//
// It deliberately stops there. It does NOT create work, does NOT write a
// WorkHandoff row, and does NOT persist readiness (readiness is derived, never
// stored). Turning a suggestion into work requires human confirmation and then
// recipient acceptance — both outside this engine (and outside this PR).
//
// The engine identifies the next responsibility; Loop resolves the person. That
// relationship is never reversed: a person is found FROM a responsibility.
// ---------------------------------------------------------------------------

import type { ResponsibilityRepository } from '../repositories/responsibility.repository';
import type { RoutingVia, ResponsibilityKey } from '../repositories/work-intelligence.policy';

import { evaluateReadiness, type ReadinessRequest, type ReadinessResult } from './operational-readiness';
// Side-effect import: registers the Buyer & Vendor adapters with the kernel.
import './operational-readiness.adapters';

// A SUGGESTION, not a handoff. No WorkHandoff row exists; nothing is owned yet.
// `suggestedToUserId` is null when the responsibility is unassigned or ambiguous —
// the engine never silently picks an arbitrary user (routedVia says why).
export interface SuggestedHandoff {
  responsibilityKey: ResponsibilityKey;
  responsibilityId: string | null; // null when the responsibility is not yet seeded
  suggestedToUserId: string | null;
  routedVia: RoutingVia;
  reason: string;
}

export interface ReadinessAssessment extends ReadinessResult {
  // Present only for a 'suggested_handoff' disposition with a resolvable
  // responsibility. Null otherwise (no_action / attention).
  suggestedHandoff: SuggestedHandoff | null;
}

export class OperationalReadinessService {
  constructor(private readonly responsibilities: ResponsibilityRepository) {}

  // Assess a process for an organization. Pure evaluation + responsibility→person
  // resolution. No writes of any kind.
  async assess<T>(
    organizationId: string,
    request: ReadinessRequest<T>,
  ): Promise<ReadinessAssessment> {
    const result = evaluateReadiness(request);

    let suggestedHandoff: SuggestedHandoff | null = null;
    if (result.disposition === 'suggested_handoff' && result.nextResponsibilityKey) {
      suggestedHandoff = await this.resolveSuggestedHandoff(
        organizationId,
        result.nextResponsibilityKey,
        result.reason,
      );
    }

    return { ...result, suggestedHandoff };
  }

  // Resolve a responsibility KEY to a suggested recipient. Fails closed: an
  // unseeded responsibility yields a null id and 'needs_owner'; an ambiguous or
  // unassigned responsibility yields a null user with the routing reason.
  private async resolveSuggestedHandoff(
    organizationId: string,
    responsibilityKey: ResponsibilityKey,
    reason: string,
  ): Promise<SuggestedHandoff> {
    const responsibility = await this.responsibilities.findResponsibilityByKey(
      organizationId,
      responsibilityKey,
    );
    if (!responsibility) {
      return {
        responsibilityKey,
        responsibilityId: null,
        suggestedToUserId: null,
        routedVia: 'needs_owner',
        reason,
      };
    }
    const routed = await this.responsibilities.resolveResponsibleActor(
      organizationId,
      responsibility.id,
    );
    return {
      responsibilityKey,
      responsibilityId: responsibility.id,
      suggestedToUserId: routed.userId,
      routedVia: routed.via,
      reason,
    };
  }
}
