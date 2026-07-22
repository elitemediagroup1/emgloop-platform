'use client';

// CallGridDateRange — the one CallGrid reporting date control, shared by every
// tab. Fast presets (Yesterday / Today / This Week / More) plus an expanded panel
// with the grouped presets and a custom start–end range. The selection lives in
// the URL (?range=…), so it persists as the operator moves between CallGrid tabs
// and is shareable. All boundaries are resolved Eastern server-side; this control
// only chooses the range. No data access here.

import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  CALLGRID_PRESET_GROUPS,
  callGridRangeQuery,
  type CallGridPreset,
} from '@emgloop/shared';

interface Props {
  preset: CallGridPreset;
  customStart?: string;
  customEnd?: string;
  label: string;
}

export default function CallGridDateRange({ preset, customStart, customEnd, label }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(customStart ?? '');
  const [end, setEnd] = useState(customEnd ?? '');

  function go(next: CallGridPreset, custom?: { start?: string; end?: string }) {
    const q = callGridRangeQuery(next, custom);
    router.push(q ? `${pathname}?${q}` : pathname);
    setOpen(false);
  }

  const fast: { p: CallGridPreset; label: string }[] = [
    { p: 'yesterday', label: 'Yesterday' },
    { p: 'today', label: 'Today' },
    { p: 'this_week', label: 'This Week' },
  ];

  return (
    <div className="cgdr">
      <div className="cgdr__bar">
        {fast.map((f) => (
          <button
            key={f.p}
            type="button"
            className={'cgdr__btn' + (preset === f.p ? ' cgdr__btn--active' : '')}
            aria-pressed={preset === f.p}
            onClick={() => go(f.p)}
          >
            {f.label}
          </button>
        ))}
        <button
          type="button"
          className={'cgdr__btn cgdr__more' + (open ? ' cgdr__btn--active' : '')}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          More ▾
        </button>
        <span className="cgdr__label">{label} · Eastern Time</span>
      </div>

      {open ? (
        <div className="cgdr__panel" role="dialog" aria-label="Choose a date range">
          <div className="cgdr__groups">
            {CALLGRID_PRESET_GROUPS.map((g) => (
              <div className="cgdr__group" key={g.group}>
                <p className="cgdr__grouptitle">{g.group}</p>
                <div className="cgdr__grouprow">
                  {g.items.map((it) => (
                    <button
                      key={it.preset}
                      type="button"
                      className={'cgdr__preset' + (preset === it.preset ? ' cgdr__preset--active' : '')}
                      onClick={() => go(it.preset)}
                    >
                      {it.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="cgdr__custom">
            <p className="cgdr__grouptitle">Custom range</p>
            <div className="cgdr__customrow">
              <label className="cgdr__field">
                <span>Start</span>
                <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
              </label>
              <label className="cgdr__field">
                <span>End</span>
                <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
              </label>
              <button
                type="button"
                className="cgdr__apply"
                disabled={!start || !end}
                onClick={() => go('custom', { start, end })}
              >
                Apply
              </button>
            </div>
            <p className="cgdr__hint">Inclusive of both dates · Eastern Time.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
