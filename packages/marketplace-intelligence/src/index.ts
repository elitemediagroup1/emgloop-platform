// @emgloop/marketplace-intelligence — package barrel.
//
// PR #43 (Marketplace Intelligence Canonical Domain Model). Contracts only: no
// AI, no provider integrations, no DB coupling, no API, no UI. Depends solely
// on @emgloop/shared and @emgloop/brain, reusing every Brain contract rather
// than duplicating it. Not yet wired into the web app build; a future PR
// decides how/when to populate and surface this model.

export * from './common';
export * from './campaign-intelligence';
export * from './buyer-intelligence';
export * from './source-intelligence';
export * from './vendor-intelligence';
export * from './marketplace-funnel';
export * from './profitability';
export * from './brain-insight';
export * from './marketplace-intelligence';

// PR #44 (Marketplace Intelligence CallGrid Assembler). The CallGrid input
// boundary and the pure, unwired assembler that projects reconciled CallGrid
// report facts into the canonical model above. CallGrid-specific vocabulary is
// isolated entirely to './callgrid-input'; the assembler emits only the
// sensor-neutral model. Additive, read-only, wired into no runtime path.
export * from './callgrid-input';
export * from './callgrid-assembler';

// PR #45 (CallGrid Assembler verification harness). Pure, framework-free proof
// that the PR #44 assembler maps fixed CallGrid rows into the canonical model
// correctly. No test runner is added; it compiles as part of typecheck and may
// be invoked via runCallGridAssemblerVerification(). No I/O, no runtime wiring.
export * from './callgrid-assembler-verification';

// PR #46 (Marketplace Intelligence Brain Enrichment). A pure, deterministic,
// unwired reasoning step: enrichMarketplaceIntelligence() takes an already-
// assembled snapshot and returns an enriched one with health, confidence,
// recommendations (RecommendationEnvelope), and insights (BrainActivity)
// populated from deterministic rules — removing BRAIN_NOT_WIRED where a rule
// fires and preserving unknowns where evidence is insufficient. No new output
// shape, no UI/API/DB/schema/runtime wiring/LLM.
export * from './brain-enrichment';

// PR #46 (Brain Enrichment verification harness). Pure, framework-free proof
// that enrichMarketplaceIntelligence maps fixed neutral snapshots correctly.
// No test runner is added; it compiles under typecheck and may be invoked via
// runBrainEnrichmentVerification(). No I/O, no runtime wiring.
export * from './brain-enrichment-verification';
