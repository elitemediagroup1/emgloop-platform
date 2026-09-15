// People bulk selection — the one model the list's checkboxes, its bulk bar and
// the bulk server actions share. Pure: no React, no DOM, no I/O.
//
// The rule it exists to hold: what the toolbar says is selected, what the rows
// show as checked, and the IDs a bulk action receives are the same set. The
// previous bar watched checkbox DOM nodes it found once, on mount. Rows that
// React later replaced had no listener, so partial selection never showed the
// bar, and after "select all" an unchecked row stayed in both the count and the
// submitted IDs -- Apply would have written to a person the table showed as
// unselected.

export type Picked = ReadonlySet<string>;

/** The selection that is shown and submitted: picked rows that are on screen, in row order. */
export function selectedIds(picked: Picked, rowIds: readonly string[]): string[] {
  return rowIds.filter((id) => picked.has(id));
}

/** Every row on screen is selected (and there is at least one). */
export function allSelected(picked: Picked, rowIds: readonly string[]): boolean {
  return rowIds.length > 0 && rowIds.every((id) => picked.has(id));
}

/** Some, but not all, rows on screen are selected: the select-all box is indeterminate. */
export function partlySelected(picked: Picked, rowIds: readonly string[]): boolean {
  const n = selectedIds(picked, rowIds).length;
  return n > 0 && n < rowIds.length;
}

/** Check or uncheck one row. A row that is not on screen cannot be selected. */
export function toggleRow(picked: Picked, rowIds: readonly string[], id: string): Set<string> {
  const next = new Set(selectedIds(picked, rowIds));
  if (!rowIds.includes(id)) return next;
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The select-all box: selects every row on screen, or clears when all already are. */
export function toggleAll(picked: Picked, rowIds: readonly string[]): Set<string> {
  return allSelected(picked, rowIds) ? new Set() : new Set(rowIds);
}

/** The value of a bulk form's hidden `ids` field. */
export function formatBulkIds(ids: readonly string[]): string {
  return ids.join(',');
}

/** What a bulk action reads back from that field: non-empty, trimmed, each ID once. */
export function parseBulkIds(raw: unknown): string[] {
  const ids = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}
