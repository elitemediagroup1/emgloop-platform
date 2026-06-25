'use client';

// BulkBar — Sprint 6 (Internal CRM, Phase 2).
//
// A lightweight client selection bar for the Customers list. It watches the
// row checkboxes rendered by the server component (data-bulk-row / data-bulk-all)
// and, when one or more rows are selected, surfaces bulk actions: set pipeline
// status, add a tag, assign a human / AI by name. Each action posts to a server
// action with the selected ids (comma-joined in a hidden field). No client
// data store — selection is pure DOM state; all persistence is server-side.

import { useEffect, useState } from 'react';
import {
  bulkSetStatusAction,
  bulkAddTagAction,
  bulkAssignAction,
} from '../../../crm/actions';
import { PIPELINE_STATUSES } from '@emgloop/database';

export function BulkBar({ tags }: { tags: string[] }) {
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    const rows = () =>
      Array.from(
        document.querySelectorAll<HTMLInputElement>('input[data-bulk-row]'),
      );
    const all = document.querySelector<HTMLInputElement>('input[data-bulk-all]');

    const recompute = () =>
      setSelected(rows().filter((r) => r.checked).map((r) => r.value));

    const onRow = () => {
      recompute();
      if (all) {
        const list = rows();
        all.checked = list.length > 0 && list.every((r) => r.checked);
      }
    };
    const onAll = () => {
      if (!all) return;
      rows().forEach((r) => {
        r.checked = all.checked;
      });
      recompute();
    };

    rows().forEach((r) => r.addEventListener('change', onRow));
    all?.addEventListener('change', onAll);
    recompute();

    return () => {
      rows().forEach((r) => r.removeEventListener('change', onRow));
      all?.removeEventListener('change', onAll);
    };
  }, []);

  if (selected.length === 0) return null;
  const ids = selected.join(',');

  return (
    <div className="crm-bulkbar">
      <span className="crm-bulk-count">{selected.length} selected</span>

      <form action={bulkSetStatusAction} className="crm-bulk-group">
        <input type="hidden" name="ids" value={ids} />
        <select className="crm-select" name="status" defaultValue="">
          <option value="" disabled>
            Set status…
          </option>
          {PIPELINE_STATUSES.map((s) => (
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
