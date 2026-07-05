# EMG Loop OS - v5 Executive Briefing Experience (PR #55)

A philosophy shift, not more dashboard polish. The homepage is redesigned
around a single question: what do I need to know, and what should I do next?

## The idea

EMG Loop is an operating system, not a business dashboard. Opening it should
feel like opening macOS in the morning. The Brain summarizes, the UI guides,
and the data exists only to support those two things.

## New information hierarchy

1. Executive Briefing hero - a calm, minimal narrative that owns the top of
   the page (greeting, one-line takeaway, supporting sentence, Review Briefing).
   Until Brain data exists, it uses the existing placeholder philosophy and
   never fabricates values.
2. Decision Queue - the former Needs Attention, reframed as an executive inbox
   of rows with large click targets and minimal borders.
3. Operating modules - quiet launch points, not dashboards. Sparklines whisper.
4. Marketplace snapshot - the progress bars are kept; ranked data shows only
   when it exists, otherwise a plain empty state.
5. Right rail - Executive Briefing, Recent Activity, Live Calls, Integration
   Status, with visual weight reduced so it supports rather than competes.

## Visual language

- More whitespace, fewer borders, fewer shadows.
- Stronger typographic hierarchy.
- Restrained palette: blue, green, amber, red, and neutrals only.
- Calm and almost luxurious.

## Scope and guarantees

- Presentation only. No routing, permissions, auth, repository, Brain, API,
  or Marketplace Intelligence changes.
- No fabricated data. Nothing is computed. Every value comes from existing sources.
- No charts, gauges, or new widgets. Pure CSS. Additive CSS only.
- Existing components are reused. Files changed: page.tsx, loop-os.css, this doc.

## Accessibility

- Large click targets and visible focus states.
- Reduced motion respected.
- Readable contrast on neutral surfaces.

## Verification

- Routes, permissions, auth, repositories, and Brain unchanged.
- Preview green. Draft. Do not merge.
