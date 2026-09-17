/* EMG Loop — the brand wordmark.
 *
 * THE OFFICIAL ARTWORK, NOT A LOOKALIKE. The mark is the EMG Loop logo Matt supplied
 * (2026-09-17), traced into vector outlines: public/brand/emg-loop-wordmark.svg. It used to
 * be approximated here with SVG <text> in Inter and a hand-drawn infinity, which rendered
 * with the wrong letterforms, weights and proportions ("EMG L∞p"). Outlines need no font,
 * stay crisp at any size, and carry the brand's navy-to-teal gradient.
 *
 * Two files, one drawing:
 *   - emg-loop-wordmark.svg          navy → teal, for light surfaces (sign-in, phone header)
 *   - emg-loop-wordmark-on-dark.svg  white → light teal, for the navy navigation rail
 *
 * Pure presentational; safe in any server component.
 */
import * as React from 'react';

/** Width ÷ height of the traced artwork (its viewBox). */
export const EMG_LOOP_WORDMARK_ASPECT = 980 / 159.75;

export const EMG_LOOP_WORDMARK_SRC = {
  default: '/brand/emg-loop-wordmark.svg',
  onDark: '/brand/emg-loop-wordmark-on-dark.svg',
} as const;

export function EmgLoopWordmark({
  height = 26,
  title = 'EMG Loop',
  tone = 'default',
}: {
  height?: number;
  title?: string;
  /** `onDark` for the navy navigation rail. */
  tone?: 'default' | 'onDark';
}) {
  return (
    // A static brand asset: next/image would add nothing for a small cached SVG.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="emg-wordmark"
      src={EMG_LOOP_WORDMARK_SRC[tone]}
      alt={title}
      width={Math.round(height * EMG_LOOP_WORDMARK_ASPECT)}
      height={height}
      decoding="async"
    />
  );
}
