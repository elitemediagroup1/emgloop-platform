'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SidebarIcon } from '../app/crm/_brand/SidebarIcon';
import { areaEntries, areaOfItem, resolveActiveNav, type NavGroup, type NavItem, type ShellArea } from './config';

// The Loop sidebar navigation and breadcrumb leaf, drawn from groups already
// resolved for one person on the server (see nav-access.ts).
//
// WHY THESE ARE CLIENT LEAVES. The shell is mounted by persistent layouts
// (/crm, /app/admin, ...). Next does not re-render a layout on client-side
// navigation, so an active item computed on the server froze on whatever page
// was hard-loaded: open People, click Conversations, and People stayed
// highlighted. The current path is client state; reading it with usePathname
// keeps the highlight and the breadcrumb on the page actually shown.
//
// FOLDS (2026-09-24). A group's `folded` items sit behind one disclosure row
// (its `fold` label, else the group label). Primary items render as links under
// the group heading as before; a group whose every item is folded draws no
// heading, the row carries the label, and the whole group folds. The fold is
// open exactly when the page shown is inside it, on the server and on the first
// client render alike, so hydration never disagrees; the person's own choice,
// remembered in this browser, applies after mount. The Administration foot goes
// through the same code path.
//
// Presentation only: they render exactly the groups they are given, hold no
// permission logic, and never become an authorization decision.

function useActiveItem(groups: readonly NavGroup[]): NavItem | null {
  return resolveActiveNav({ nav: [...groups] }, usePathname());
}

// ---- The fold plan: pure, and testable without a router --------------------

/** A group's disclosure row and the items behind it. */
export interface FoldPlan {
  /** Stable key of this fold, `${group label or 'home'}:${fold label}` slugified: the remembered choice is stored under it. */
  key: string;
  /** The DOM id of the list the row controls. */
  id: string;
  /** What the row says: the group's fold label, else the group's own label. */
  label: string;
  /** The folded items, in registry order. */
  items: NavItem[];
  /** How many of them can be opened: the count the row shows. */
  count: number;
  /** The page shown is one of the folded items, so the fold opens itself. */
  activeInside: boolean;
}

/** How one group is drawn: a heading over its primary links, and its fold, if it has one. */
export interface GroupPlan {
  group: NavGroup;
  /** The heading over the primary links; none when every item is folded (the row carries the label) or the group is unlabelled. */
  heading: string | null;
  primary: NavItem[];
  fold: FoldPlan | null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The render plan for these groups when `activeHref` is the page shown. Pure: no router, no storage. */
export function foldPlan(groups: readonly NavGroup[], activeHref: string | null): GroupPlan[] {
  return groups.map((group) => {
    const primary = group.items.filter((i) => !i.folded);
    const folded = group.items.filter((i) => i.folded);
    let fold: FoldPlan | null = null;
    if (folded.length > 0) {
      const label = group.fold?.label ?? group.label;
      const key = slug(`${group.label || 'home'}:${label}`);
      fold = {
        key,
        id: `loop-fold-${key}`,
        label,
        items: folded,
        count: folded.filter((i) => !i.soon).length,
        activeInside: activeHref !== null && folded.some((i) => i.href === activeHref),
      };
    }
    return { group, heading: primary.length > 0 && group.label ? group.label : null, primary, fold };
  });
}

// ---- The person's open/closed choices: a per-browser convenience -----------
//
// One localStorage key holds a JSON object of fold key -> open. It is read once
// after mount and written on every toggle, each inside try/catch: a private
// window, a full quota or a blocked store only means the choice is not
// remembered. It never leaves the browser and is never an authorization input.

const FOLD_STORE = 'loop.nav.folds';
type FoldChoices = Readonly<Record<string, boolean>>;

function readFoldChoices(): FoldChoices {
  try {
    const raw = window.localStorage.getItem(FOLD_STORE);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'boolean') out[key] = value;
    return out;
  } catch {
    return {};
  }
}

function writeFoldChoices(choices: FoldChoices): void {
  try {
    window.localStorage.setItem(FOLD_STORE, JSON.stringify(choices));
  } catch {
    // Not remembered this time; the rail still works.
  }
}

/**
 * Which folds are open. open = remembered choice (default closed), forced open
 * while the page shown is inside the fold unless the person closed it there; a
 * close made inside is forgotten as soon as the page shown changes.
 */
function useFolds(activeHref: string | null) {
  const [choices, setChoices] = useState<FoldChoices>({});
  const [closedInside, setClosedInside] = useState<{ at: string | null; keys: readonly string[] }>({ at: null, keys: [] });
  useEffect(() => {
    setChoices(readFoldChoices());
  }, []);
  useEffect(() => {
    setClosedInside((c) => (c.at === activeHref || c.keys.length === 0 ? c : { at: null, keys: [] }));
  }, [activeHref]);
  const closedHere = closedInside.at === activeHref ? closedInside.keys : [];
  const isOpen = (fold: FoldPlan) => (choices[fold.key] ?? false) || (fold.activeInside && !closedHere.includes(fold.key));
  const toggle = (fold: FoldPlan) => {
    const next = !isOpen(fold);
    const all = { ...choices, [fold.key]: next };
    setChoices(all);
    writeFoldChoices(all);
    if (fold.activeInside) {
      setClosedInside({ at: activeHref, keys: next ? closedHere.filter((k) => k !== fold.key) : [...closedHere, fold.key] });
    }
  };
  return { isOpen, toggle };
}

// ---- Drawing ---------------------------------------------------------------

// One nav link, shared by primary items, fold lists and the Administration
// foot — the sidebar has ONE link implementation, never per-route variants.
function NavLink({ item, active }: { item: NavItem; active: string | null }) {
  const isActive = item.href === active;
  const className = 'loop-sb__link' + (isActive ? ' is-active' : '') + (item.soon ? ' is-disabled' : '');
  const content = (
    <>
      <span className="loop-sb__ico">
        <SidebarIcon name={item.icon} />
      </span>
      <span>{item.label}</span>
      {item.soon ? <span className="loop-sb__soon">Soon</span> : null}
    </>
  );
  return item.soon ? (
    <span className={className} aria-disabled>
      {content}
    </span>
  ) : (
    <Link className={className} href={item.href} aria-current={isActive ? 'page' : undefined}>
      {content}
    </Link>
  );
}

// The disclosure row and the list it controls. The list is hidden with the
// `hidden` attribute, never by style, so what is closed is out of the
// accessibility tree and the tab order too.
function Fold({ fold, active, open, onToggle }: { fold: FoldPlan; active: string | null; open: boolean; onToggle: () => void }) {
  return (
    <>
      <button
        type="button"
        className={'loop-sb__fold' + (fold.activeInside ? ' is-inside' : '')}
        aria-expanded={open}
        aria-controls={fold.id}
        onClick={onToggle}
      >
        <span className="loop-sb__chev" aria-hidden="true">
          <SidebarIcon name="chevron" size={14} />
        </span>
        <span>{fold.label}</span>
        <span className="loop-sb__foldcount">{fold.count}</span>
      </button>
      <div id={fold.id} className="loop-sb__foldlist" hidden={!open}>
        {fold.items.map((item) => (
          <NavLink item={item} active={active} key={item.href} />
        ))}
      </div>
    </>
  );
}

function Group({ plan, active, open, onToggle }: { plan: GroupPlan; active: string | null; open: boolean; onToggle: () => void }) {
  return (
    <div className="loop-sb__group">
      {plan.heading ? <div className="loop-sb__grouplabel">{plan.heading}</div> : null}
      {plan.primary.map((item) => (
        <NavLink item={item} active={active} key={item.href} />
      ))}
      {plan.fold ? <Fold fold={plan.fold} active={active} open={open} onToggle={onToggle} /> : null}
    </div>
  );
}

export function ShellNav({ groups, label }: { groups: readonly NavGroup[]; label: string }) {
  const activeHref = useActiveItem(groups)?.href ?? null;
  const folds = useFolds(activeHref);
  const plans = foldPlan(groups, activeHref);
  const draw = (plan: GroupPlan, fallbackKey: string) => (
    <Group
      plan={plan}
      active={activeHref}
      open={plan.fold ? folds.isOpen(plan.fold) : false}
      onToggle={() => plan.fold && folds.toggle(plan.fold)}
      key={plan.group.label || fallbackKey}
    />
  );
  const main = plans.filter((p) => !p.group.footer);
  const foot = plans.filter((p) => p.group.footer);
  return (
    <>
      <nav className="loop-sb__scroll" aria-label={label}>
        {main.map((plan, i) => draw(plan, `g${i}`))}
      </nav>
      {foot.length > 0 ? (
        <nav className="loop-sb__adminarea" aria-label="Administration">
          {foot.map((plan, i) => draw(plan, `f${i}`))}
        </nav>
      ) : null}
    </>
  );
}

/** The breadcrumb leaf: the item that owns the current path, never an empty crumb. */
export function ShellCrumb({ groups }: { groups: readonly NavGroup[] }) {
  return <span aria-current="page">{useActiveItem(groups)?.label ?? 'Overview'}</span>;
}

const AREA_ICON: Record<ShellArea, string> = {
  HOME: 'grid',
  CRM: 'users',
  WORK: 'columns',
  INTELLIGENCE: 'chart',
  OPERATIONS: 'activity',
  // The creator seat's areas: the same glyphs as their sidebar items.
  CONTENT: 'grid',
  OPPORTUNITIES: 'target',
  TASKS: 'check',
  EARNINGS: 'revenue',
};

/**
 * The compact operating-area bar for narrow screens (handoff p. 15: mobile is action
 * first). One entry per area this person can open, leading to that area's first
 * item; the area of the page actually shown is marked current. Presentation only:
 * it draws the same server-resolved groups as the sidebar.
 */
export function AreaBar({ groups }: { groups: readonly NavGroup[] }) {
  const current = areaOfItem(groups, useActiveItem(groups));
  const entries = areaEntries(groups);
  if (entries.length === 0) return null;
  return (
    <nav className="loop-areabar" aria-label="Operating areas">
      {entries.map((entry) => {
        const isActive = entry.area === current;
        return (
          <Link
            key={entry.area}
            className={'loop-areabar__link' + (isActive ? ' is-active' : '')}
            href={entry.href}
            aria-current={isActive ? 'true' : undefined}
          >
            <span className="loop-areabar__ico" aria-hidden="true">
              <SidebarIcon name={AREA_ICON[entry.area]} />
            </span>
            <span>{entry.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
