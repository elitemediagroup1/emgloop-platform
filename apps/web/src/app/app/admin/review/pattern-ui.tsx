// What repeated Cases amount to — and the four things they cannot conclude.
//
// A PATTERN IS NEVER DOCTRINE. No count reaches the top maturity, and the
// refusal saying so rides on every pattern at every count. A surface that let
// "seen four times" read as "how EMG operates" would be the product learning the
// wrong lesson in public.
//
// PREFERENCE AND OUTCOME ARE SHOWN APART. How often an option was chosen says
// what people prefer; how often it was followed by a monitored recovery is a
// statement about correlation. Averaging them into one "effectiveness" figure
// would make agreement look like evidence, so they render as two columns and
// never as one number.

import { PATTERN_MATURITY_LABELS, type PatternView } from '@emgloop/shared';

import { NotKnown } from '../../_loop-os/product-state';

export function PatternCard({ pattern }: { pattern: PatternView }) {
  return (
    <div className="pt-card">
      <header className="pt-card__head">
        <span className={'pt-card__maturity pt-card__maturity--' + pattern.maturity.toLowerCase()}>
          {PATTERN_MATURITY_LABELS[pattern.maturity]}
        </span>
        <span className="pt-card__n">
          {pattern.caseIds.length} comparable{' '}
          {pattern.caseIds.length === 1 ? 'investigation' : 'investigations'}
        </span>
      </header>

      <div className="pt-cols">
        <div className="pt-col">
          <h3>What people chose</h3>
          {pattern.chosen.length > 0 ? (
            <ul>
              {pattern.chosen.map((c) => (
                <li key={c.optionKey}>
                  <span className="pt-col__k">{c.optionKey}</span>
                  <span className="pt-col__v">{c.count}×</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pt-col__empty">Nobody selected an option on these.</p>
          )}
          <p className="pt-col__caveat">A statement about preference, not about what works.</p>
        </div>

        <div className="pt-col">
          <h3>Followed by a monitored recovery</h3>
          {pattern.followedByRecovery.length > 0 ? (
            <ul>
              {pattern.followedByRecovery.map((c) => (
                <li key={c.optionKey}>
                  <span className="pt-col__k">{c.optionKey}</span>
                  {/* THE DENOMINATOR IS MONITORED CASES, NOT ALL CASES. A Case
                      nobody watched did not "not recover" — it was not looked at. */}
                  <span className="pt-col__v">
                    {c.count} of {c.ofMonitored} monitored
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pt-col__empty">None of these were monitored.</p>
          )}
          <p className="pt-col__caveat">A statement about correlation, not about cause.</p>
        </div>
      </div>

      {pattern.explanation.length > 0 ? (
        <ul className="pt-card__expl">
          {pattern.explanation.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}

      {/* CARRIED, ALWAYS. The refusals are the product here — a pattern without
          them is a conclusion. */}
      <NotKnown title="What this does not establish" lines={pattern.cannotConclude} />
    </div>
  );
}
