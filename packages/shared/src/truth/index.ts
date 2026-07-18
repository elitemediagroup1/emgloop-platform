// Truth States — the platform's semantic model for what is actually known.
//
// Mandatory platform architecture. See docs/TRUTH_STATES.md.
//
// The one rule that matters: only SUCCESS and EMPTY may render a numeric zero.
// The type system enforces it — `value` does not exist on UNKNOWN, UNAVAILABLE
// or ERROR, so reading it is a compile error rather than a silent zero.

export * from './state';
export * from './construct';
export * from './render';
export * from './serialize';
