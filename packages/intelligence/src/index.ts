// @emgloop/intelligence — package barrel.
//
// INTELLIGENCE MODULE 1: the reusable Intelligence Module framework and its
// first production module, CallGrid. The Executive Briefing consumes module
// outputs; additional modules (In My City, Talent, …) implement the same
// `IntelligenceModule` contract and appear in the briefing with no rewrite.
//
// Pure, deterministic, provider-neutral once consumed, and honest about
// ignorance: no I/O, no clock, no fabricated metric or recommendation. Depends
// only on @emgloop/brain (canonical Brain contracts) and @emgloop/shared.

export * from './module';
export * from './build';
export * from './briefing';

// Marketplace Coverage — what the Brain knows, what it does not, and why.
// Status is always derived from counted observations, never authored.
export * from './coverage';

// CallGrid module (its input boundary is the only CallGrid-vocabulary surface).
export * from './callgrid/input';
export * from './callgrid/analyze';
export * from './callgrid/transcript';
export * from './callgrid/module';
export * from './callgrid/verification';

// --- Marketplace Intelligence (Module 2) -----------------------------------
// Explains why marketplace opportunity is lost BEFORE a call exists.
// Domain model and rule contract only — no ingestion until discovery completes.
// Platform Evidence Engine — consumed by every intelligence module.
export * from './evidence/types';
export * from './evidence/engine';
export * from './evidence/verification';
export * from './marketplace/evidence';
export * from './marketplace/taxonomy';
export * from './marketplace/rule';
export * from './marketplace/engine';
export * from './marketplace/score';
