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

// CallGrid module (its input boundary is the only CallGrid-vocabulary surface).
export * from './callgrid/input';
export * from './callgrid/analyze';
export * from './callgrid/transcript';
export * from './callgrid/module';
export * from './callgrid/verification';
