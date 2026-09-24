// How the gateway reads provider policies (G2): the recorded controls, with a short cache.
//
// ONE READER FOR EVERY DEPLOYABLE. The web tier (Netlify functions) and the connections worker
// both build their gateway with this, over their own Prisma client. Neither reads an environment
// variable for G2: LOOP_AI_PROVIDER_TERMS_CONFIRMED no longer means anything.
//
// THE CACHE IS SHORT AND IN-PROCESS: 30 seconds by default, never more than 60. A policy recorded
// or KILLED therefore takes effect on every running instance within a minute, without a deploy.
// Only a SUCCESSFUL read is cached; a failed read throws, the gateway refuses the call as
// PROVIDER_POLICY_UNREADABLE, and the next call reads again. A cached empty list is a real answer
// (no policy recorded) and refuses as PROVIDER_POLICY_MISSING until it expires.

import type { PrismaClient } from '@prisma/client';
import type { AiProviderPolicy } from '@emgloop/shared';

import { AiControlRepository } from '../../repositories/brain/ai-control.repository';

export const AI_PROVIDER_POLICY_CACHE_MS = 30_000;
export const AI_PROVIDER_POLICY_CACHE_MAX_MS = 60_000;

export interface AiProviderPolicySource {
  providerPolicies(): Promise<readonly AiProviderPolicy[]>;
}

/**
 * A reader over `source` (production: `AiControlRepository` on the deployable's Prisma client)
 * that caches a successful read for `ttlMs`, clamped to [0, 60 s].
 */
export function cachedAiProviderPolicies(
  source: AiProviderPolicySource,
  options: { readonly ttlMs?: number; readonly nowMs?: () => number } = {},
): () => Promise<readonly AiProviderPolicy[]> {
  const ttl = Math.max(0, Math.min(options.ttlMs ?? AI_PROVIDER_POLICY_CACHE_MS, AI_PROVIDER_POLICY_CACHE_MAX_MS));
  const nowMs = options.nowMs ?? (() => Date.now());
  let cached: { readonly at: number; readonly policies: readonly AiProviderPolicy[] } | null = null;
  return async () => {
    const now = nowMs();
    if (cached && now - cached.at < ttl) return cached.policies;
    const policies = Object.freeze([...(await source.providerPolicies())]);
    cached = { at: now, policies };
    return policies;
  };
}

/** The production reader: the recorded controls in this deployable's database, cached briefly. */
export function aiProviderPolicyReader(prisma: PrismaClient, options: { readonly ttlMs?: number } = {}): () => Promise<readonly AiProviderPolicy[]> {
  return cachedAiProviderPolicies(new AiControlRepository(prisma), options);
}
