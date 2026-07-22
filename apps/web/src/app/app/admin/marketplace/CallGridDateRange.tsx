'use client';

// CallGridDateRange — the one CallGrid reporting date control, shared by every
// tab. Fast presets (Yesterday / Today / This Week / More) plus an expanded panel
// with grouped presets and a two-month visual calendar for a custom start–end
// range (prev/next month navigation, start + end selection, Apply, Cancel). The
// selection lives in the URL (?range=…), so it persists as the operator moves
// between CallGrid tabs and is shareable. All boundaries resolve Eastern
// server-side; this control only chooses the range. No data access here.

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

const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const pad = (n: number) => String(n).padStart(2, '0');
const ymdStr = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const firstWeekday = (y: number, m: number) => new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
const nextYm = (y: number, m: number) => (m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 });
const prevYm = (y: number, m: number) => (m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 });

function Month({
  y, m, start, end, onPick,
}: {
  y: number; m: number; start: string; end: string; onPick: (d: string) => void;
}) {
  const lead = firstWeekday(y, m);
  const total = daysInMonth(y, m);
  const cells: (number | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push(d);

  const now = new Date();
  const todayStr = ymdStr(now.getFullYear(), now.getMonth() + 1, now.getDate());

  return (
    <div className="cgcal__month">
      <div className="cgcal__monthname">{MONTHS_FULL[m - 1]} {y}</div>
      <div className="cgcal__grid">
        {WEEKDAYS.map((w, i) => <span key={i} className="cgcal__dow">{w}</span>)}
        {cells.map((d, i) => {
          if (d === null) return <span key={i} className="cgcal__pad" />;
          const s = ymdStr(y, m, d);
          const isStart = s === start;
          const isEnd = s === end;
          const inRange = start && end && s > start && s < end;
          const cls =
            'cgcal__day' +
            (isStart ? ' cgcal__day--start' : '') +
            (isEnd ? ' cgcal__day--end' : '') +
            (inRange ? ' cgcal__day--range' : '') +
            (s === todayStr ? ' cgcal__day--today' : '');
          return (
            <button key={i} type="button" className={cls} onClick={() => onPick(s)}>
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function CallGridDateRange({ preset, customStart, customEnd, label }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const init = customStart ? customStart.split('-') : null;
  const now = new Date();
  const [view, setView] = useState<{ y: number; m: number }>(
    init ? { y: Number(init[0]), m: Number(init[1]) } : { y: now.getFullYear(), m: now.getMonth() + 1 },
  );
  const [start, setStart] = useState(customStart ?? '');
  const [end, setEnd] = useState(customEnd ?? '');

  function go(next: CallGridPreset, custom?: { start?: string; end?: string }) {
    const q = callGridRangeQuery(next, custom);
    router.push(q ? `${pathname}?${q}` : pathname);
    setOpen(false);
  }
  function close() {
    setStart(customStart ?? '');
    setEnd(customEnd ?? '');
    setOpen(false);
  }
  function pick(d: string) {
    if (!start || (start && end)) { setStart(d); setEnd(''); return; }
    if (d >= start) setEnd(d);
    else { setStart(d); setEnd(''); }
  }

  const fast: { p: CallGridPreset; label: string }[] = [
    { p: 'yesterday', label: 'Yesterday' },
    { p: 'today', label: 'Today' },
    { p: 'this_week', label: 'This Week' },
  ];
  const right = nextYm(view.y, view.m);

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
            <div className="cgcal__head">
              <p className="cgdr__grouptitle">Custom range</p>
              <div className="cgcal__nav">
                <button type="button" className="cgcal__navbtn" aria-label="Previous month" onClick={() => setView(prevYm(view.y, view.m))}>‹</button>
                <button type="button" className="cgcal__navbtn" aria-label="Next month" onClick={() => setView(nextYm(view.y, view.m))}>›</button>
              </div>
            </div>
            <div className="cgcal">
              <Month y={view.y} m={view.m} start={start} end={end} onPick={pick} />
              <Month y={right.y} m={right.m} start={start} end={end} onPick={pick} />
            </div>
            <div className="cgcal__foot">
              <span className="cgdr__hint">
                {start && end ? `${start} → ${end} · Eastern Time` : start ? `${start} → …` : 'Pick a start and end date · Eastern Time.'}
              </span>
              <div className="cgcal__actions">
                <button type="button" className="cgdr__btn" onClick={close}>Cancel</button>
                <button type="button" className="cgdr__apply" disabled={!start || !end} onClick={() => go('custom', { start, end })}>Apply</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
