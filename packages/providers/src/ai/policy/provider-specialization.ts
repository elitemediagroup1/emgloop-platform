// Which provider each capability route prefers. Slice B2; approved 2026-09-16.
//
// Architecture: docs/architecture/brain-execution-architecture.md §5a.
//
// A PREFERENCE, NOT A VERDICT. Matt and Charlie decided that Brain uses provider
// specialization rather than one universal primary. This table records that decision
// as data. It is not a claim that either provider is better in general, and it names
// no model: the routing policy chooses exact, verified models per task version, and
// must follow this preference or say why (`aiRoutingConformance`).
//
// PREFERENCE DECIDES THE PRIMARY ONLY. Fallback stays availability behaviour under the
// failure policy, is recorded on every call, and never happens because another
// provider's output is preferred.
//
// CHANGING A PREFERENCE IS A NEW VERSION of this file, reviewed like any policy.

import type { AiProviderSpecializationPolicy } from '@emgloop/shared';

export const AI_PROVIDER_SPECIALIZATION_POLICY_VERSION = 'specialization.2026-09-16.1';

export const AI_PROVIDER_SPECIALIZATION_POLICY: AiProviderSpecializationPolicy = Object.freeze({
  version: AI_PROVIDER_SPECIALIZATION_POLICY_VERSION,
  routes: Object.freeze({
    COMMUNICATION: Object.freeze({
      preferredProviderId: 'openai',
      rationale: 'Approved 2026-09-16: OpenAI is preferred for work whose main output is language meant for a person.',
    }),
    TECHNICAL_ANALYSIS: Object.freeze({
      preferredProviderId: 'anthropic',
      rationale:
        'Approved 2026-09-16: Anthropic is preferred for technical reasoning, investigations, evidence synthesis and diagnostics.',
    }),
    GENERAL_REASONING: Object.freeze({
      preferredProviderId: null,
      rationale: "Approved 2026-09-16: no global default. Each task's reviewed routing entry names its provider and says why.",
    }),
  }),
});
