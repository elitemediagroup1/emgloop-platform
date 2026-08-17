// Observation completeness — the pure layer.
//
// THE ONE PROPERTY THIS FILE EXISTS FOR
//
// Loop must never present absence of ingested data as a measured commercial
// decline. In August 2026, three consecutive days ingested nothing and landed
// inside a Stage 3 trailing-7-day comparison window. Every rule then written was
// working correctly, and the answer they would have produced was a large,
// material, publishable revenue and call-volume collapse — because a day with no
// rows and a day nobody looked at were the same thing to every query in the
// platform.
//
// The regression at the bottom of section 1 is that exact shape, pinned.
//
// The second property matters just as much and is easier to lose: a PROVEN zero
// is real data. A guard that refused to measure any quiet day would be safe and
// useless, and would quietly re-teach the platform that zero means broken.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPARISON_SPAN_DAYS,
  MATERIALITY_WITHHOLDINGS,
  OBSERVATION_RULE_VERSION,
  PROVIDER_OBSERVATION_STATUSES,
  assessWindowObservation,
  certifiesObservation,
  describeUnobserved,
  easternBusinessDatesIn,
  easternBusinessDayWindow,
  easternBusinessDate,
  easternTrailingCompleteWindows,
  measureChange,
  startOfEasternDay,
  startOfNextEasternDay,
  type BusinessDate,
  type PopulationWindowAggregate,
  type ProviderObservationStatus,
  type WindowObservation,
} from '../src/index';

// The clock the whole August scenario is anchored to. Monday 2026-08-17, which
// makes the trailing complete window Aug 10–16 and the prior window Aug 3–9 —
// precisely the pair the real gap straddled.
const AUGUST_NOW = new Date('2026-08-17T14:30:00.000Z');
const WINDOWS = easternTrailingCompleteWindows(AUGUST_NOW, COMPARISON_SPAN_DAYS);
const ALL_DATES = [
  ...easternBusinessDatesIn(WINDOWS.prior),
  ...easternBusinessDatesIn(WINDOWS.current),
];

/** The three days CallGrid delivered nothing for. */
const MISSING: BusinessDate[] = ['2026-08-11', '2026-08-12', '2026-08-13'];

function ledger(
  overrides: Record<BusinessDate, ProviderObservationStatus | null> = {},
): Map<BusinessDate, ProviderObservationStatus> {
  const m = new Map<BusinessDate, ProviderObservationStatus>();
  for (const d of ALL_DATES) m.set(d, 'SUCCESS');
  for (const [d, status] of Object.entries(overrides)) {
    if (status === null) m.delete(d);
    else m.set(d, status);
  }
  return m;
}

function agg(over: Partial<PopulationWindowAggregate> = {}): PopulationWindowAggregate {
  return {
    totalCalls: 100,
    revenueCents: 1_000_000,
    revenueReported: 100,
    monetizedTrue: 40,
    monetizedReported: 100,
    convertedTrue: 20,
    convertedReported: 100,
    noRouteTrue: 3,
    noRouteReported: 100,
    ...over,
  };
}

function measure(
  observation: WindowObservation,
  current: PopulationWindowAggregate,
  prior: PopulationWindowAggregate,
  metric: Parameters<typeof measureChange>[0]['metric'] = 'CALL_VOLUME',
) {
  return measureChange({
    metric,
    direction: 'HIGHER_IS_BETTER',
    current,
    prior,
    currentWindow: WINDOWS.current,
    priorWindow: WINDOWS.prior,
    observation,
  });
}

// --- 1. The August regression ----------------------------------------------------

test('the August window: three unobserved days never become a measured decline', () => {
  // The shape of the real incident. The current window holds only the calls from
  // the four days that DID ingest; the prior week is complete. Measured naively
  // that is a 63% collapse in call volume, far past every threshold the rule has.
  const observation = assessWindowObservation(
    ALL_DATES,
    ledger(Object.fromEntries(MISSING.map((d) => [d, null]))),
  );

  const naive = measure(observation, agg({ totalCalls: 3_400 }), agg({ totalCalls: 9_100 }));

  assert.equal(naive.material, false, 'an ingestion gap is not a material development');
  assert.equal(naive.withheld, 'WINDOW_NOT_OBSERVED');

  // NOT COMPUTED, NOT MERELY HIDDEN. There is no number here for a later caller
  // to pick up and render — which is the difference between a guard and a curtain.
  assert.equal(naive.current.value, null);
  assert.equal(naive.prior.value, null);
  assert.equal(naive.absoluteChange, null);
  assert.equal(naive.percentageChange, null);
  assert.equal(naive.movement, null);
  assert.equal(naive.againstObjective, null);

  // And the reason travels WITH the result, naming the days, so an operator knows
  // what to go and fix rather than only that something was wrong.
  const said = naive.unknowns.join(' ');
  for (const day of MISSING) assert.ok(said.includes(day), `should name ${day}`);
});

test('every metric refuses the August window, not just the one that looks worst', () => {
  const observation = assessWindowObservation(
    ALL_DATES,
    ledger(Object.fromEntries(MISSING.map((d) => [d, null]))),
  );
  for (const metric of ['CALL_VOLUME', 'REVENUE', 'MONETIZED_RATE', 'CONVERSION_RATE'] as const) {
    const result = measure(observation, agg({ totalCalls: 3_400, revenueCents: 400_000 }), agg(), metric);
    assert.equal(result.withheld, 'WINDOW_NOT_OBSERVED', `${metric} must refuse`);
    assert.equal(result.current.value, null, `${metric} must not compute a value`);
  }
});

// --- 2. A proven zero is real data -----------------------------------------------

test('a day the provider proved empty still certifies, and the window measures', () => {
  // EMPTY means "read cleanly, provider returned no rows". That is an observation,
  // not a gap. A guard that refused it would be safe and useless.
  const observation = assessWindowObservation(
    ALL_DATES,
    ledger({ '2026-08-15': 'EMPTY', '2026-08-16': 'EMPTY', '2026-08-09': 'EMPTY' }),
  );

  assert.equal(observation.fullyObserved, true);
  assert.equal(observation.observedDayCount, ALL_DATES.length);

  const result = measure(observation, agg({ totalCalls: 60 }), agg({ totalCalls: 100 }));
  assert.notEqual(result.withheld, 'WINDOW_NOT_OBSERVED');
  assert.equal(result.current.value, 60, 'a measured value, because the days were observed');
  assert.equal(result.prior.value, 100);
});

test('certifiesObservation admits exactly SUCCESS and EMPTY', () => {
  const certifying = PROVIDER_OBSERVATION_STATUSES.filter(certifiesObservation);
  assert.deepEqual([...certifying].sort(), ['EMPTY', 'SUCCESS']);
  // Absence of a row is not a status and never certifies.
  assert.equal(certifiesObservation(null), false);
  assert.equal(certifiesObservation(undefined), false);
});

// --- 3. Every uncertified outcome withholds --------------------------------------

test('a truncated read is a lower bound, never a certified day', () => {
  const observation = assessWindowObservation(
    ALL_DATES,
    ledger({ '2026-08-12': 'PARTIAL_PAGINATION' }),
  );
  assert.equal(observation.fullyObserved, false);
  assert.equal(observation.uncertified.length, 1);
  assert.equal(observation.uncertified[0]!.status, 'PARTIAL_PAGINATION');
  assert.equal(measure(observation, agg({ totalCalls: 40 }), agg()).withheld, 'WINDOW_NOT_OBSERVED');
});

test('a failed provider read does not certify, and says which failure it was', () => {
  for (const status of ['ENDPOINT_FAILURE', 'MALFORMED_RESPONSE', 'UNKNOWN_ENVELOPE'] as const) {
    const observation = assessWindowObservation(ALL_DATES, ledger({ '2026-08-12': status }));
    assert.equal(observation.fullyObserved, false, `${status} must not certify`);
    assert.equal(observation.uncertified[0]!.status, status);
    assert.ok(observation.uncertified[0]!.reason.length > 0, 'a reason is always given');
    assert.equal(measure(observation, agg(), agg()).withheld, 'WINDOW_NOT_OBSERVED');
  }
});

test('no ledger row is UNKNOWN, and is reported differently from a failed read', () => {
  const missing = assessWindowObservation(ALL_DATES, ledger({ '2026-08-12': null }));
  const failed = assessWindowObservation(ALL_DATES, ledger({ '2026-08-12': 'ENDPOINT_FAILURE' }));

  assert.equal(missing.uncertified[0]!.status, null, 'never observed is a null status');
  assert.equal(failed.uncertified[0]!.status, 'ENDPOINT_FAILURE');
  // "Nobody looked" and "we looked and it broke" are different operational facts
  // with different fixes, so they must not collapse into one message.
  assert.notEqual(missing.uncertified[0]!.reason, failed.uncertified[0]!.reason);

  assert.equal(measure(missing, agg(), agg()).withheld, 'WINDOW_NOT_OBSERVED');
});

test('an empty ledger withholds every one of the fourteen days', () => {
  const observation = assessWindowObservation(ALL_DATES, new Map());
  assert.equal(observation.observedDayCount, 0);
  assert.equal(observation.uncertified.length, COMPARISON_SPAN_DAYS * 2);
  assert.equal(observation.fullyObserved, false);
});

// --- 4. All fourteen certified: normal measurement is untouched -------------------

test('with all fourteen certified, the existing rule decides exactly as before', () => {
  const observation = assessWindowObservation(ALL_DATES, ledger());
  assert.equal(observation.fullyObserved, true);
  assert.equal(observation.observedDayCount, 14);
  assert.equal(observation.ruleVersion, OBSERVATION_RULE_VERSION);

  // Material: a real, large, well-sampled move still speaks.
  const material = measure(observation, agg({ totalCalls: 60 }), agg({ totalCalls: 100 }));
  assert.equal(material.material, true);
  assert.equal(material.movement, 'DECREASE');

  // And an ordinary week still stays quiet, for the reason it always did.
  const quiet = measure(observation, agg({ totalCalls: 99 }), agg({ totalCalls: 100 }));
  assert.equal(quiet.material, false);
  assert.equal(quiet.withheld, 'BELOW_THRESHOLD', 'observation must not mask materiality');
});

test('the comparison covers exactly fourteen complete business dates', () => {
  assert.equal(easternBusinessDatesIn(WINDOWS.prior).length, COMPARISON_SPAN_DAYS);
  assert.equal(easternBusinessDatesIn(WINDOWS.current).length, COMPARISON_SPAN_DAYS);
  assert.deepEqual(easternBusinessDatesIn(WINDOWS.current), [
    '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
    '2026-08-14', '2026-08-15', '2026-08-16',
  ]);
  assert.deepEqual(easternBusinessDatesIn(WINDOWS.prior), [
    '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
    '2026-08-07', '2026-08-08', '2026-08-09',
  ]);
  // The in-progress day can never be certified into a measurement, because it is
  // never in the window at all.
  assert.equal(ALL_DATES.includes('2026-08-17'), false);
});

// --- 5. Eastern business dates and their UTC boundaries ---------------------------

test('a business date resolves to the Eastern day, not the UTC one', () => {
  // 00:30 UTC on the 12th is 20:30 Eastern on the 11th. A UTC-derived date would
  // put this call in the wrong day, and certify a window it was never in.
  assert.equal(easternBusinessDate(new Date('2026-08-12T00:30:00.000Z')), '2026-08-11');
  assert.equal(easternBusinessDate(new Date('2026-08-12T04:00:00.000Z')), '2026-08-12');
});

test('a summer business day is the 04:00-to-04:00 UTC interval, and is 24 hours', () => {
  const w = easternBusinessDayWindow('2026-08-12');
  assert.equal(w.start.toISOString(), '2026-08-12T04:00:00.000Z', 'EDT is UTC-4');
  assert.equal(w.end.toISOString(), '2026-08-13T04:00:00.000Z');
  assert.equal(w.end.getTime() - w.start.getTime(), 24 * 3_600_000);
});

test('a winter business day shifts to 05:00 UTC, because EST is UTC-5', () => {
  const w = easternBusinessDayWindow('2026-01-15');
  assert.equal(w.start.toISOString(), '2026-01-15T05:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-01-16T05:00:00.000Z');
});

test('the certified window and the measured window are the same instants', () => {
  // THE SILENT KILLER. If certification covered a different 24 hours than
  // measurement, Loop would certify one day and measure another and no test would
  // notice — the counts would simply be slightly wrong forever.
  for (const date of ALL_DATES) {
    const day = easternBusinessDayWindow(date);
    assert.equal(day.start.getTime(), startOfEasternDay(day.start).getTime());
    assert.equal(day.end.getTime(), startOfNextEasternDay(day.start).getTime());
  }
  const first = easternBusinessDayWindow(ALL_DATES[0]!);
  const last = easternBusinessDayWindow(ALL_DATES[ALL_DATES.length - 1]!);
  assert.equal(first.start.getTime(), WINDOWS.prior.start.getTime(), 'first certified day opens the comparison');
  assert.equal(last.end.getTime(), WINDOWS.current.end.getTime(), 'last certified day closes it');
});

// --- 6. DST ----------------------------------------------------------------------

test('spring forward: the short day is 23 hours and still exactly one date', () => {
  // 2026-03-08, EST -> EDT at 02:00 local.
  const short = easternBusinessDayWindow('2026-03-08');
  assert.equal(short.start.toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(short.end.toISOString(), '2026-03-09T04:00:00.000Z');
  assert.equal(short.end.getTime() - short.start.getTime(), 23 * 3_600_000);
  assert.deepEqual(easternBusinessDatesIn(short), ['2026-03-08']);
});

test('fall back: the long day is 25 hours and still exactly one date', () => {
  // 2026-11-01, EDT -> EST at 02:00 local.
  const long = easternBusinessDayWindow('2026-11-01');
  assert.equal(long.start.toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(long.end.toISOString(), '2026-11-02T05:00:00.000Z');
  assert.equal(long.end.getTime() - long.start.getTime(), 25 * 3_600_000);
  assert.deepEqual(easternBusinessDatesIn(long), ['2026-11-01']);
});

test('a comparison spanning a DST transition still enumerates fourteen days', () => {
  // The window that contains fall-back. Naive `start + n * 86_400_000` arithmetic
  // yields 13 or 15 dates here, or repeats one — which would either withhold a
  // measurable window forever or certify a day twice.
  const windows = easternTrailingCompleteWindows(new Date('2026-11-09T14:30:00.000Z'), COMPARISON_SPAN_DAYS);
  const dates = [
    ...easternBusinessDatesIn(windows.prior),
    ...easternBusinessDatesIn(windows.current),
  ];
  assert.equal(dates.length, 14);
  assert.equal(new Set(dates).size, 14, 'no day is enumerated twice across the transition');
  assert.ok(dates.includes('2026-11-01'), 'the 25-hour day is in the window');

  const observation = assessWindowObservation(
    dates,
    new Map(dates.map((d) => [d, 'SUCCESS' as const])),
  );
  assert.equal(observation.fullyObserved, true);
  assert.equal(observation.observedDayCount, 14);
});

// --- 7. Vocabulary and reporting -------------------------------------------------

test('WINDOW_NOT_OBSERVED is part of the closed withholding vocabulary', () => {
  assert.ok(MATERIALITY_WITHHOLDINGS.includes('WINDOW_NOT_OBSERVED'));
});

test('a long run of unobserved days is summarised without becoming unreadable', () => {
  const observation = assessWindowObservation(ALL_DATES, new Map());
  const said = describeUnobserved(observation, 3);
  assert.ok(said.includes('14 of 14'));
  assert.ok(said.includes('and 11 more'), 'the cap states that it applied');
});
