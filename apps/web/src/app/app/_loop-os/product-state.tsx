// The one place a governed backend state becomes something a person reads.
//
// WHY THIS FILE IS THE WHOLE POINT. Loop's single advantage is that it knows the
// difference between "we checked and it is fine" and "we cannot tell". That
// difference is worth nothing if it survives eleven layers of backend and then
// dies in a React component that renders both as a grey badge. Every governed
// state reaching a Stage 4 surface passes through here, and nothing else in the
// UI is allowed to decide what a state looks like.
//
// IT TRANSLATES; IT NEVER DECIDES. `productLabel()` in `@emgloop/shared` owns the
// mapping from a governed state to a human word, and this owns only how that
// word is DRESSED -- a tone, a glyph, and whether the technical name is shown
// beside it. If a state has no label, this renders the raw governed value rather
// than inventing a reassuring one, because a state nobody has named is a state
// nobody has thought about and the UI must not paper over that.
//
// NO SECOND DICTIONARY. A `const LABELS = { ... }` in a page component would be
// the third translation layer in a repository that already documents two token
// sets and three nav configs as its defining failure. There is one, it is
// imported, and a test walks the Stage 4 surfaces asserting no component
// declares its own.
//
// COLOUR IS NEVER THE ONLY SIGNAL. Every badge carries a word. Every uncertain
// state carries a word that means uncertain. Somebody reading this on a
// monochrome screen, or with any form of colour blindness, gets the same
// information as everybody else -- which is also why the glyphs differ in SHAPE
// rather than only in hue.

import type { ProductLabel, ProductTone } from '@emgloop/shared';
import { productLabel } from '@emgloop/shared';
import type { Tone } from './types';

/**
 * How each product tone is dressed, using the four-value vocabulary the Loop OS
 * shell already has.
 *
 * FOUR VISUAL TONES, FIVE PRODUCT TONES, AND THE COLLAPSE IS DELIBERATE.
 * `Tone` is the shell's existing vocabulary and inventing a fifth would mean new
 * CSS for every surface in the product. What distinguishes NEEDS_SETUP from
 * WAITING_FOR_DATA is not the colour -- both are "warn" -- it is the WORD and
 * the GLYPH, which is the right place for that difference to live anyway: one is
 * fixed by waiting and the other by somebody deciding something, and a person
 * needs to read which.
 */
const TONE_STYLE: Record<ProductTone, { tone: Tone; glyph: string; sr: string }> = {
  // Loop stands behind it.
  VERIFIED: { tone: 'good', glyph: '✓', sr: 'Established' },
  // Real, and partial. Not an error, and not fine.
  INCOMPLETE: { tone: 'warn', glyph: '◑', sr: 'Incomplete' },
  // Nobody has to act; something has to arrive.
  WAITING_FOR_DATA: { tone: 'idle', glyph: '◷', sr: 'Waiting' },
  // Somebody has to decide something. This will not resolve itself.
  NEEDS_SETUP: { tone: 'warn', glyph: '⚙', sr: 'Needs setup' },
  // The evidence disagrees with itself. Neither waiting nor configuring helps.
  CONFLICTING: { tone: 'crit', glyph: '⚠', sr: 'Conflicting' },
};

export function toneFor(t: ProductTone): Tone {
  return TONE_STYLE[t].tone;
}

/**
 * A governed state, rendered for a person.
 *
 * `technical` SHOWS THE GOVERNED NAME BESIDE THE WORD, for the surfaces where an
 * operator is the reader. It is off by default: an executive should never need
 * to know what RECONCILIATION_INCONCLUSIVE means, and an operator must always be
 * able to find out. That is the whole of progressive disclosure in one prop.
 *
 * AN UNMAPPED STATE RENDERS ITS RAW NAME. Not "Unknown", not a blank, not a
 * cheerful default -- the actual governed value, so whoever added a state
 * without naming it sees their omission on screen instead of a plausible lie.
 */
export function StateBadge(props: {
  state: string;
  technical?: boolean;
  className?: string;
}) {
  const label = productLabel(props.state);
  if (!label) {
    return (
      <span className={'ps-badge ps-badge--idle ' + (props.className ?? '')}>
        <span className="ps-badge__glyph" aria-hidden="true">?</span>
        <span className="ps-badge__label ps-badge__label--raw">{props.state}</span>
      </span>
    );
  }
  const style = TONE_STYLE[label.tone];
  return (
    <span
      className={'ps-badge ps-badge--' + style.tone + ' ' + (props.className ?? '')}
      title={label.detail}
    >
      <span className="ps-badge__glyph" aria-hidden="true">{style.glyph}</span>
      <span className="ps-badge__label">{label.label}</span>
      {props.technical ? (
        <span className="ps-badge__tech" aria-label={'Governed state: ' + label.from}>
          {label.from}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The badge plus its sentence. For the places a person is meeting a state for
 * the first time and a two-word chip is not enough.
 */
export function StateNote(props: { state: string; technical?: boolean }) {
  const label = productLabel(props.state);
  if (!label) {
    return (
      <p className="ps-note ps-note--idle">
        <strong>{props.state}</strong> — Loop has no plain-language description for this state yet.
      </p>
    );
  }
  return (
    <p className={'ps-note ps-note--' + TONE_STYLE[label.tone].tone}>
      <StateBadge state={props.state} technical={props.technical} />
      <span className="ps-note__detail">{label.detail}</span>
    </p>
  );
}

/**
 * Several governed states at once — the evidence posture of a Headline, the
 * withholdings behind a refusal.
 *
 * DE-DUPLICATED BY LABEL, NOT BY STATE. Three withholdings that all mean
 * "waiting for data" are one thing a person needs to know, and the governed
 * names remain in the technical disclosure underneath. Showing the same word
 * three times teaches nobody anything.
 */
export function StateList(props: { states: readonly string[]; technical?: boolean }) {
  const seen = new Set<string>();
  const shown: string[] = [];
  for (const s of props.states) {
    const key = productLabel(s)?.label ?? s;
    if (seen.has(key)) continue;
    seen.add(key);
    shown.push(s);
  }
  if (shown.length === 0) return null;
  return (
    <span className="ps-list">
      {shown.map((s) => (
        <StateBadge key={s} state={s} technical={props.technical} />
      ))}
    </span>
  );
}

/**
 * What Loop could not establish, as a first-class block rather than an absence.
 *
 * RENDERS NOTHING WHEN THERE IS NOTHING, and that is the only case in which this
 * component is silent. A surface that omitted it when the list was long -- to
 * save space, to look calmer -- would be hiding the exact thing that makes the
 * rest of the page trustworthy.
 */
export function NotKnown(props: { lines: readonly string[]; title?: string }) {
  if (props.lines.length === 0) return null;
  return (
    <section className="ps-unknown" aria-labelledby="ps-unknown-h">
      <h3 className="ps-unknown__title" id="ps-unknown-h">
        <span className="ps-unknown__glyph" aria-hidden="true">◑</span>
        {props.title ?? "What Loop doesn't know"}
      </h3>
      <ul className="ps-unknown__list">
        {props.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A read that FAILED, which is not a state Loop is in — it is a state Loop
 * cannot report.
 *
 * ERROR IS NOT UNKNOWN, AND THIS IS THE COMPONENT THAT KEEPS THEM APART. UNKNOWN
 * means Loop looked and could not establish something; it is intelligence.
 * ERROR means Loop could not look. Rendering a failed read as an empty
 * successful state is the single most damaging thing this UI could do, because
 * "no headlines today" and "the headline service is down" would become the same
 * screen — and one of them is a reason to relax.
 */
export function ReadError(props: { what: string; retryHref?: string }) {
  return (
    <div className="ps-error" role="alert">
      <span className="ps-error__glyph" aria-hidden="true">✕</span>
      <div className="ps-error__text">
        <strong className="ps-error__title">Loop could not load {props.what}.</strong>
        <span className="ps-error__body">
          This is a failure to read, not a finding. Nothing here should be taken as evidence that
          {' '}{props.what} is healthy or empty.
        </span>
      </div>
      {props.retryHref ? (
        <a className="ent-btn ent-btn--ghost ps-error__retry" href={props.retryHref}>
          Try again
        </a>
      ) : null}
    </div>
  );
}

/** Re-exported so a surface imports one module rather than two. */
export type { ProductLabel, ProductTone };
export { productLabel };
