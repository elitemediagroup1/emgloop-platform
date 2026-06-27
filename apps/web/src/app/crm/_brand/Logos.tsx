/* EMG Loop — Brand marks (Sprint 13).
 *
 * Pure presentational SVG components recreating the official EMG Loop wordmark
 * and a compact Elite Media Group mark, using the brand navy→teal gradient.
 * No client hooks — safe to render anywhere in the server component tree.
 */
import * as React from 'react';

const NAVY = '#1B2A6B';
const TEAL = '#2E9B9B';

/** Full EMG Loop wordmark: navy "EMG", infinity "Loop" with navy→teal gradient. */
export function EmgLoopWordmark({
  height = 26,
  title = 'EMG Loop',
}: {
  height?: number;
  title?: string;
}) {
  const w = (height / 26) * 132;
  return (
    <svg
      role="img"
      aria-label={title}
      width={w}
      height={height}
      viewBox="0 0 132 26"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <defs>
        <linearGradient id="emgLoopGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={NAVY} />
          <stop offset="1" stopColor={TEAL} />
        </linearGradient>
      </defs>
      {/* EMG */}
      <text
        x="0"
        y="20"
        fontFamily="Inter, system-ui, sans-serif"
        fontWeight="800"
        fontSize="22"
        letterSpacing="-0.5"
        fill={NAVY}
      >
        EMG
      </text>
      {/* Loop wordmark */}
      <text
        x="54"
        y="20"
        fontFamily="Inter, system-ui, sans-serif"
        fontWeight="600"
        fontSize="22"
        letterSpacing="0"
        fill="url(#emgLoopGrad)"
      >
        L
      </text>
      {/* Infinity "oo" */}
      <g stroke="url(#emgLoopGrad)" strokeWidth="3" fill="none" strokeLinecap="round">
        <path d="M70 9 C70 5, 76 5, 79 9 C82 13, 88 13, 88 9 C88 5, 82 5, 79 9 C76 13, 70 13, 70 9 Z" />
      </g>
      <text
        x="90"
        y="20"
        fontFamily="Inter, system-ui, sans-serif"
        fontWeight="600"
        fontSize="22"
        fill={TEAL}
      >
        p
      </text>
      <text x="103" y="9" fontFamily="Inter, system-ui, sans-serif" fontWeight="700" fontSize="7" fill={TEAL}>
        ™
      </text>
    </svg>
  );
}

/** Compact EMG Loop glyph (infinity mark only) for tight spaces / favicons. */
export function EmgLoopGlyph({ size = 26 }: { size?: number }) {
  return (
    <svg
      role="img"
      aria-label="EMG Loop"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="emgGlyphGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={NAVY} />
          <stop offset="1" stopColor={TEAL} />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#emgGlyphGrad)" />
      <g stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round">
        <path d="M9 16 C9 11, 15 11, 16 16 C17 21, 23 21, 23 16 C23 11, 17 11, 16 16 C15 21, 9 21, 9 16 Z" />
      </g>
    </svg>
  );
}

/** Compact Elite Media Group mark: heart silhouette + navy→teal gradient. */
export function EliteMediaGroupMark({
  height = 18,
  withWordmark = true,
}: {
  height?: number;
  withWordmark?: boolean;
}) {
  const w = withWordmark ? (height / 18) * 96 : (height / 18) * 20;
  return (
    <svg
      role="img"
      aria-label="Elite Media Group"
      width={w}
      height={height}
      viewBox={withWordmark ? '0 0 96 18' : '0 0 20 18'}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Elite Media Group</title>
      <defs>
        <linearGradient id="emgHeartGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={NAVY} />
          <stop offset="1" stopColor={TEAL} />
        </linearGradient>
      </defs>
      <path
        d="M9 16.5 C9 16.5 1.5 11.5 1.5 6.3 C1.5 3.4 3.7 1.5 6.1 1.5 C7.6 1.5 8.6 2.4 9 3.2 C9.4 2.4 10.4 1.5 11.9 1.5 C14.3 1.5 16.5 3.4 16.5 6.3 C16.5 11.5 9 16.5 9 16.5 Z"
        stroke="url(#emgHeartGrad)"
        strokeWidth="1.6"
        fill="none"
      />
      {withWordmark ? (
        <>
          <text x="24" y="9" fontFamily="Inter, system-ui, sans-serif" fontWeight="800" fontSize="9" fill={NAVY}>
            ELITE
          </text>
          <text x="24" y="16" fontFamily="Inter, system-ui, sans-serif" fontWeight="600" fontSize="5.4" letterSpacing="1.2" fill={TEAL}>
            MEDIA GROUP
          </text>
        </>
      ) : null}
    </svg>
  );
}
