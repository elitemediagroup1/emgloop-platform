# EMG Loop OS v6 - Executive Focus & Information Architecture (PR #56)

Stacked on PR #55 (executive briefing foundation). Presentation only. No
Brain logic, repositories, APIs, Prisma, auth, routing, permissions, or
calculations were touched. No data was fabricated.

## Intent

An Apple-style design review of the v5 homepage: remove anything that does
not help an executive answer five questions, until the page feels calm and
immediately understandable.

1. Is my business healthy?
2. What requires my attention?
3. Where is business activity happening?
4. What is the Brain telling me?
5. Where do I go next?

## Changes

### Removed duplicated navigation
The sidebar and the old Quick Actions row navigated to identical
destinations. Quick Actions (and its now-unused ActionTile component) were
removed entirely. The sidebar remains the single navigation surface.

### Added Executive Insight
Where Quick Actions used to be, a calm three-part Executive Insight panel
surfaces information that actually helps: Today's Activity (attributed calls
and live calls), Marketplace Momentum (qualified calls and bookings), and a
Brain Insight cell with an honest "preparing today's briefing" state. Every
value is read from existing read-only repositories or renders an honest
placeholder. Nothing is fabricated.

### Reassure-first hero
The hero now leads with a calm status strip ("Marketplace activity is
healthy", "Operations are stable") derived from existing signals before
naming the number of decisions. The call to action reads "Review Executive
Briefing". The system calms the user before asking them to work.

### Quieter operating modules
Sparklines in the module grid are turned down (low opacity, brightening
softly on hover) so the modules read as launch pads rather than dashboards.
Detailed analytics stay inside each workspace.

### Refined Decision Queue
Larger click targets, comfortable row spacing, minimal chrome, and a soft
hover background so the queue reads like an executive inbox.

### Lighter right rail
Right-rail cards lose their shadow and sit on a flatter surface, reducing
their visual dominance so they support rather than compete with the main
content.

## Safety

- The entire page logic layer (data fetch, derivations, components) is
  byte-identical to PR #55, except for the removal of the unused ActionTile
  component.
- CSS is purely additive and scoped to .loop-os--v6, so no other workspace
  is affected.
- No color-mix, no animation libraries, reduced-motion respected.
- All special characters are encoding-safe (JSX expression or JS string
  literal form only).

## Files changed

- apps/web/src/app/app/admin/page.tsx (edit v5 to v6)
- apps/web/src/app/loop-os.css (additive v6 layer)
- docs/LOOP_OS_EXECUTIVE_FOCUS_V6.md (this file)
