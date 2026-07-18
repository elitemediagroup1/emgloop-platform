// Truth States — the compile-time guarantee, as an executable regression test.
//
// The framework's central claim is that an engineer CANNOT accidentally render
// UNKNOWN as zero, because there is no value to reach for. That claim is only
// worth anything if it is enforced, so it is asserted here.
//
// HOW THIS WORKS: every `@ts-expect-error` below asserts that the line beneath
// it DOES NOT COMPILE. If someone weakens the model — adds `value?: T` to the
// base, widens the union, or introduces a `valueOr()` helper — the error stops
// occurring, `@ts-expect-error` becomes an unused-directive error, and
// `tsc --noEmit` fails. The guarantee cannot rot silently.
//
// This file is type-level only. It ships no runtime behavior.

import { hasValue, isPartial, foldTruth, type Truth } from './index';

declare const revenue: Truth<number>;
declare const buyers: Truth<readonly string[]>;

// --- What MUST NOT compile -------------------------------------------------

export function unsafeAccessIsImpossible(): void {
  // The original bug: read the value, render it, ship a zero.
  // @ts-expect-error `value` does not exist on UNKNOWN / UNAVAILABLE / ERROR.
  void revenue.value;

  // The "helpful" default that would reintroduce every bug this model prevents.
  // @ts-expect-error nullish-coalescing cannot rescue a property that is absent from the type.
  void (revenue.value ?? 0);

  // Same hole via a list — an unmeasured list is not an empty list.
  // @ts-expect-error `value` does not exist on the non-value states.
  void buyers.value.length;

  // Reasons are equally protected: ERROR carries a TruthError, not a Reason.
  // @ts-expect-error `reason` does not exist on SUCCESS / EMPTY / PARTIAL / ERROR.
  void revenue.reason;

  // ERROR's payload is not reachable without narrowing either.
  // @ts-expect-error `error` does not exist on the non-error states.
  void revenue.error;

  // Coverage is only present on PARTIAL, so a caller cannot claim completeness.
  // @ts-expect-error `coverage` does not exist outside PARTIAL.
  void revenue.coverage;
}

// --- What MUST compile -----------------------------------------------------
//
// The safe paths have to stay ergonomic, or engineers will route around them.

export function safeAccessWorks(): number {
  if (hasValue(revenue)) {
    // Narrowed to SUCCESS | EMPTY | PARTIAL — a real, measured number.
    return revenue.value;
  }
  return Number.NaN;
}

export function coverageIsReachableWhenPartial(): number | null {
  return isPartial(revenue) ? revenue.coverage.observed : null;
}

export function foldIsTotal(): string {
  return foldTruth(revenue, {
    success: (v) => `measured ${v}`,
    empty: () => 'measured, and genuinely zero',
    partial: (v, c) => `at least ${v} (saw ${c.observed})`,
    unknown: (r) => `unknown: ${r.summary}`,
    unavailable: (r) => `unavailable: ${r.summary}`,
    error: (e) => `failed: ${e.summary}`,
  });
}
