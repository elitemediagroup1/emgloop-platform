// Stage 5 — GovernanceEvaluator (PURE, deny-by-default).
//
// Given the applicable ACTIVE policies plus the request context, decides
// ALLOW / DENY / REQUIRE_APPROVAL and returns the permitted purpose subset with
// human-readable reasons (persisted for audit). Every state and knowledge
// evaluator downstream is gated by this — none may bypass it.
//
// Deny-by-default triggers (any one denies the affected purpose):
//   - no purpose requested
//   - no applicable policy at all
//   - the requested purpose is not allowed by any policy
//   - a policy explicitly denies the purpose (DENY wins across policies)
//   - a policy requires consent and consentBasis is NONE
//   - the channel is outside every granting policy's allowedChannels
//   - aggregation requested but no policy permits aggregation

import type { DataGovernancePolicy, DataPurpose } from '@prisma/client';
import type { GovernanceDecision } from './types';

export interface GovernanceContext {
  policies: DataGovernancePolicy[];
  requestedPurposes: DataPurpose[];
  channel?: string | null;
  consentBasis: string; // ConsentBasis; 'NONE' means absent
  aggregation?: boolean;
}

function channelAllowedBy(policy: DataGovernancePolicy, channel?: string | null): boolean {
  if (policy.allowedChannels.length === 0) return true; // unrestricted
  if (!channel) return false;
  return policy.allowedChannels.map((c) => c.toLowerCase()).includes(channel.toLowerCase());
}

export const GovernanceEvaluator = {
  evaluate(ctx: GovernanceContext): GovernanceDecision {
    const reasons: string[] = [];

    if (ctx.requestedPurposes.length === 0) {
      return { outcome: 'DENY', reasons: ['no purpose requested'], allowedPurposes: [] };
    }
    if (ctx.policies.length === 0) {
      return { outcome: 'DENY', reasons: ['no applicable governance policy (deny-by-default)'], allowedPurposes: [] };
    }

    // Consent gate: any policy that requires consent, with none present, denies all.
    const requiresConsent = ctx.policies.some((p) => p.requiresConsent);
    if (requiresConsent && (ctx.consentBasis === 'NONE' || !ctx.consentBasis)) {
      return { outcome: 'DENY', reasons: ['consent required but absent'], allowedPurposes: [] };
    }

    // Aggregation gate.
    if (ctx.aggregation && !ctx.policies.some((p) => p.aggregationAllowed)) {
      return { outcome: 'DENY', reasons: ['aggregation not permitted by any policy'], allowedPurposes: [] };
    }

    // Per-purpose resolution. A purpose is granted iff some policy allows it for
    // this channel AND no policy denies it (DENY wins).
    const allowedPurposes: DataPurpose[] = [];
    let requiresApproval = false;
    for (const purpose of ctx.requestedPurposes) {
      const denied = ctx.policies.some((p) => p.deniedPurposes.includes(purpose));
      if (denied) {
        reasons.push(`purpose ${purpose} explicitly denied`);
        continue;
      }
      const granting = ctx.policies.filter(
        (p) => p.allowedPurposes.includes(purpose) && channelAllowedBy(p, ctx.channel),
      );
      if (granting.length === 0) {
        reasons.push(`purpose ${purpose} not permitted for channel ${ctx.channel ?? 'n/a'}`);
        continue;
      }
      allowedPurposes.push(purpose);
      if (granting.some((p) => p.requiresHumanApproval)) requiresApproval = true;
    }

    if (allowedPurposes.length === 0) {
      return { outcome: 'DENY', reasons: reasons.length ? reasons : ['no purpose permitted'], allowedPurposes: [] };
    }
    if (requiresApproval) {
      reasons.push('a granting policy requires human approval');
      return { outcome: 'REQUIRE_APPROVAL', reasons, allowedPurposes };
    }
    reasons.push(`permitted: ${allowedPurposes.join(', ')}`);
    return { outcome: 'ALLOW', reasons, allowedPurposes };
  },
};
