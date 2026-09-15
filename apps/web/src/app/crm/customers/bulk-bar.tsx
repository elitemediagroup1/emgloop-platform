'use client';

// People bulk selection and bulk bar — client leaves inside the server-rendered
// People list.
//
// Selection is React state, shared through context by the select-all box, each
// row's box and the bar, and every change goes through the pure model in
// src/crm/bulk-selection.ts. So the checked rows, the "N selected" count and the
// IDs posted to a bulk action are one set by construction. The page keys the
// provider by the rows it shows, so a new page, filter or sort starts empty and
// a row that is no longer on screen can never be submitted.
//
// (The previous bar attached change listeners, once, to whatever checkbox nodes
// existed when it mounted. Rows React rendered later had none, so selecting
// rows could leave the bar hidden, and unchecking a row after "select all" left
// it in both the count and the IDs Apply would post.)
//
// It must not import @emgloop/database. That package's entry constructs a
// PrismaClient when it loads, and in the browser Prisma throws on first touch,
// so importing even a constant from it here crashed the whole People page on
// the client. The statuses come from the server page.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  bulkSetStatusAction,
  bulkAddTagAction,
  bulkAssignAction,
} from '../../../crm/actions';
import {
  allSelected,
  formatBulkIds,
  partlySelected,
  selectedIds,
  toggleAll,
  toggleRow,
  type Picked,
} from '../../../crm/bulk-selection';

interface Selection {
  rowIds: readonly string[];
  selected: string[];
  all: boolean;
  partly: boolean;
  toggle: (id: string) => void;
  toggleEvery: () => void;
}

const SelectionContext = createContext<Selection | null>(null);

function useSelection(): Selection {
  const selection = useContext(SelectionContext);
  if (!selection) throw new Error('People selection controls must render inside <BulkSelection>.');
  return selection;
}

export function BulkSelection({ rowIds, children }: { rowIds: readonly string[]; children: ReactNode }) {
  const [picked, setPicked] = useState<Picked>(() => new Set());
  const value: Selection = {
    rowIds,
    selected: selectedIds(picked, rowIds),
    all: allSelected(picked, rowIds),
    partly: partlySelected(picked, rowIds),
    toggle: (id) => setPicked((current) => toggleRow(current, rowIds, id)),
    toggleEvery: () => setPicked((current) => toggleAll(current, rowIds)),
  };
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function SelectAllCheckbox() {
  const { all, partly, toggleEvery, rowIds } = useSelection();
  const ref = useRef<HTMLInputElement>(null);
  // `indeterminate` has no attribute form; it can only be set on the element.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partly;
  }, [partly]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Select all"
      checked={all}
      disabled={rowIds.length === 0}
      onChange={toggleEvery}
    />
  );
}

export function RowCheckbox({ id, name }: { id: string; name: string }) {
  const { selected, toggle } = useSelection();
  return (
    <input
      type="checkbox"
      aria-label={'Select ' + name}
      checked={selected.includes(id)}
      onChange={() => toggle(id)}
    />
  );
}

export function BulkBar({ tags, statuses }: { tags: string[]; statuses: readonly string[] }) {
  const { selected } = useSelection();
  return <BulkBarView selected={selected} tags={tags} statuses={statuses} />;
}

/** The bar for a given selection. Nothing selected, nothing shown. */
export function BulkBarView({
  selected,
  tags,
  statuses,
}: {
  selected: readonly string[];
  tags: string[];
  statuses: readonly string[];
}) {
  if (selected.length === 0) return null;
  const ids = formatBulkIds(selected);

  return (
    <div className="crm-bulkbar" role="region" aria-label="Bulk actions">
      <span className="crm-bulk-count">{selected.length} selected</span>

      <form action={bulkSetStatusAction} className="crm-bulk-group">
        <input type="hidden" name="ids" value={ids} />
        <select className="crm-select" name="status" defaultValue="">
          <option value="" disabled>
            Set status…
          </option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className="crm-btn" type="submit">
          Apply
        </button>
      </form>

      <form action={bulkAddTagAction} className="crm-bulk-group">
        <input type="hidden" name="ids" value={ids} />
        <input
          className="crm-input"
          name="tag"
          list="crm-bulk-tags"
          placeholder="Add tag…"
        />
        <datalist id="crm-bulk-tags">
          {tags.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <button className="crm-btn" type="submit">
          Tag
        </button>
      </form>

      <form action={bulkAssignAction} className="crm-bulk-group">
        <input type="hidden" name="ids" value={ids} />
        <input
          className="crm-input"
          name="humanName"
          placeholder="Assign human…"
        />
        <button className="crm-btn" type="submit">
          Assign
        </button>
      </form>
    </div>
  );
}
