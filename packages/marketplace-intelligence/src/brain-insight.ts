// @emgloop/marketplace-intelligence — Brain Insight.
//
// PR #43. "Reuse existing Brain contracts wherever possible. Never duplicate
// types." BrainActivity (packages/brain/src/brain-activity.ts) ALREADY carries
// every field a Marketplace Intelligence insight needs: a plain-language
// finding (`recommendation`, empty when honestly unknown), `evidence`,
// `confidence`, `severity`, `alternativesConsidered`, `missingEvidence`, and
// `unknowns`. Rather than redeclare an overlapping shape, Marketplace
// Intelligence simply aliases it. `subject` on the underlying BrainActivity
// carries the finding's subject (e.g. 'buyer:acme-insurance',
// 'campaign:home-services-east').

import type { BrainActivity } from '@emgloop/brain';

/** A single explainable insight surfaced inside Marketplace Intelligence.
 * Identical in shape to BrainActivity — never duplicated, only named for this
 * domain's consumers. */
export type MarketplaceBrainInsight = BrainActivity;
