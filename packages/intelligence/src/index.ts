// @emgloop/intelligence — package barrel.
//
// The platform's reasoning layer. Two things live here:
//
//   1. The Evidence Engine (evidence/) — the domain-agnostic layer that turns a
//      domain's observations into coverage, confidence, freshness, provenance,
//      unknowns and contradictions. Every domain joins by writing a contributor.
//   2. The Executive Brain (executive/) — the reasoning layer that EXPLAINS the
//      business over those sensors: what happened, why, what matters, what to
//      do. It is provider-neutral; Marketplace is its first sensor, not a
//      special case.
//
// Pure, deterministic, provider-neutral, and honest about ignorance: no I/O, no
// clock, no fabricated metric or recommendation. Depends only on @emgloop/brain
// and @emgloop/shared.

// Marketplace Coverage — what the Brain knows, what it does not, and why.
// Status is always derived from counted observations, never authored.
export * from './coverage';

// --- Platform Evidence Engine ----------------------------------------------
// Consumed by every sensor. Supersedes the retired Marketplace Confidence Engine.
export * from './evidence/types';
export * from './evidence/engine';
export * from './evidence/verification';

// --- Marketplace (the first sensor) ----------------------------------------
// Explains why marketplace opportunity is lost. Reasons ONLY over metrics that
// cleared the Evidence Engine.
export * from './marketplace/evidence';
export * from './marketplace/taxonomy';
export * from './marketplace/rule';
export * from './marketplace/engine';
export * from './marketplace/score';
export * from './marketplace/auction-funnel';
export * from './marketplace/auction-evidence';
export * from './marketplace/auction-rules';
// The Marketplace → Executive Brain sensor adapter (marketplace vocabulary stops here).
export * from './marketplace/executive-sensor';

// --- Executive Brain (the reasoning layer) ---------------------------------
// The single executive surface. Supersedes assembleExecutiveBriefing and the
// CallGrid intelligence module, both retired: confidence is now DERIVED from the
// Evidence Engine, and the layer carries no domain assumptions.
export * from './executive/observation';
export * from './executive/sensor';
export * from './executive/domain-sensor';
export * from './executive/correlation';
export * from './executive/brain';
export * from './executive/verification';
