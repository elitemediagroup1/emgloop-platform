// The CallGrid command center's chrome and charts — one shell for every section.
//
// ORDER, ON EVERY SECTION: header (what this is, which period, how current), the
// five KPIs, the executive layer (Overview only: Today's Brief and Top Priorities),
// the section selector, then the section's own workspace. A section REPLACES the
// workspace; it never stacks onto one long page.
//
// Server components only. The period controls are links and a GET form, so they
// work without JavaScript and keep every section on the same period. Charts are
// plain SVG drawn from the measured series, with a null point left as a gap —
// never drawn as zero.

import Link from 'next/link';
import type { ReactNode } from 'react';

import {
  CALLGRID_PERIODS,
  CALLGRID_PERIOD_LABELS,
  CALLGRID_PRESET_GROUPS,
  formatInstant,
  type CallGridKpi,
  type CallGridFreshness,
  type TimeBucket,
} from '@emgloop/shared';

import { viewerTime } from '../../../../time/viewer-time';
import { CallGridNav, type CallGridNavKey } from './_CallGridNav';
import type { CommandContext } from './command-data';
import { withQuery } from './command-data';

// --- Formatting ---------------------------------------------------------------------------

export function money(cents: number | null): string {
  if (cents === null) return 'Unknown';
  const sign = cents < 0 ? '−' : '';
  return `${sign}$${Math.round(Math.abs(cents) / 100).toLocaleString('en-US')}`;
}
export function count(n: number | null): string {
  return n === null ? 'Unknown' : n.toLocaleString('en-US');
}
export function pct(n: number | null, digits = 0): string {
  return n === null ? '—' : `${n.toFixed(digits)}%`;
}
function kpiValue(k: CallGridKpi): string {
  if (k.state === 'UNAVAILABLE') return 'Unavailable';
  if (k.value === null) return 'Unknown';
  if (k.kind === 'money') return money(k.value);
  if (k.kind === 'percent') return `${k.value.toFixed(1)}%`;
  return k.value.toLocaleString('en-US');
}
/** An instant, in the reader's zone with the zone named (Loop Time Authority). */
export function clock(d: Date): string {
  return formatInstant(d, viewerTime().timeZone, 'time', { withZone: true });
}

// --- Freshness -------------------------------------------------------------------------------

export function FreshnessBadge({ freshness }: { freshness: CallGridFreshness }) {
  const tone = freshness.state.toLowerCase();
  const text =
    freshness.state === 'LIVE' || freshness.state === 'CURRENT'
      ? `${freshness.word}${freshness.asOf ? ` · Updated ${clock(freshness.asOf)}` : ''}`
      : freshness.word;
  return (
    <p className={`cgx-fresh cgx-fresh--${tone}`} title={freshness.detail}>
      <span className="cgx-fresh__dot" aria-hidden="true" />
      <span className="cgx-fresh__word">{text}</span>
      <span className="loop-sr-only"> — {freshness.detail}</span>
    </p>
  );
}

// --- The period controls ------------------------------------------------------------------------

const MORE_RANGES = CALLGRID_PRESET_GROUPS.flatMap((g) => g.items);

export function PeriodBar({ ctx, path }: { ctx: CommandContext; path: string }) {
  const { selection } = ctx;
  const period = selection.period;
  const nav = selection.nav;
  const link = (query: string) => (query ? `${path}?${query}` : path);
  const switchQuery = (p: (typeof CALLGRID_PERIODS)[number]) => nav?.switchQuery[p] ?? `period=${p}`;
  const currentWord = period?.period === 'weekly' ? 'This week' : period?.period === 'monthly' ? 'This month' : 'Today';
  return (
    <div className="cgx-period">
      <nav className="cgx-seg" aria-label="Reporting period">
        {CALLGRID_PERIODS.map((p) => {
          const on = period?.period === p;
          return (
            <Link key={p} href={link(switchQuery(p))} className={'cgx-seg__item' + (on ? ' cgx-seg__item--on' : '')} aria-current={on ? 'page' : undefined}>
              {CALLGRID_PERIOD_LABELS[p]}
            </Link>
          );
        })}
      </nav>
      <div className="cgx-date" role="group" aria-label="Change period">
        {nav ? (
          <Link href={link(nav.prevQuery)} className="cgx-date__step" aria-label="Previous period">‹</Link>
        ) : null}
        <span className="cgx-date__label">{selection.label}</span>
        {nav ? (
          nav.nextQuery ? (
            <Link href={link(nav.nextQuery)} className="cgx-date__step" aria-label="Next period">›</Link>
          ) : (
            <span className="cgx-date__step cgx-date__step--off" aria-hidden="true">›</span>
          )
        ) : null}
      </div>
      {nav?.currentQuery ? <Link href={link(nav.currentQuery)} className="cgx-date__now">{currentWord}</Link> : null}
      <details className="cgx-more">
        <summary className="cgx-more__button">More ranges</summary>
        <div className="cgx-more__panel">
          <ul className="cgx-more__list">
            {MORE_RANGES.map((r) => (
              <li key={r.preset}>
                <Link href={link(`range=${r.preset}`)} className="cgx-more__link">{r.label}</Link>
              </li>
            ))}
          </ul>
          <form method="get" action={path} className="cgx-more__custom">
            <input type="hidden" name="range" value="custom" />
            <label className="cgx-more__field">From <input type="date" name="s" required className="loop-input" /></label>
            <label className="cgx-more__field">To <input type="date" name="e" required className="loop-input" /></label>
            <button type="submit" className="loop-btn">Apply</button>
            <p className="cgx-more__note">Eastern Time calendar days.</p>
          </form>
        </div>
      </details>
    </div>
  );
}

// --- Sparklines and charts ----------------------------------------------------------------------

/** Points for a polyline, splitting at nulls so an unknown bucket is a gap, never a zero. */
function segments(values: readonly (number | null)[], w: number, h: number, pad: number, min: number, max: number): string[] {
  const span = max - min || 1;
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const out: string[] = [];
  let cur: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length) out.push(cur.join(' '));
      cur = [];
      return;
    }
    const x = pad + i * step;
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    cur.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (cur.length) out.push(cur.join(' '));
  return out;
}

export function Sparkline({ values, tone = 'accent', label }: { values: readonly (number | null)[]; tone?: 'accent' | 'good' | 'crit' | 'neutral'; label: string }) {
  const known = values.filter((v): v is number => v !== null);
  if (known.length < 2) return <span className="cgx-spark cgx-spark--empty" aria-hidden="true" />;
  const min = Math.min(0, ...known);
  const max = Math.max(...known);
  const w = 96;
  const h = 34;
  return (
    <svg className={`cgx-spark cgx-spark--${tone}`} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} preserveAspectRatio="none">
      {segments(values, w, h, 2, min, max).map((pts, i) => (
        <polyline key={i} points={pts} className="cgx-spark__line" fill="none" />
      ))}
    </svg>
  );
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * p;
}

/**
 * A two-series line chart over time buckets: the selected period (solid) and the
 * comparison period (dashed), index-aligned. `cumulative` draws running totals, so
 * an in-progress period reads against the comparison's same elapsed point.
 */
export function TrendChart({
  buckets, current, comparison, currentLabel, comparisonLabel, format, cumulative = false, title,
}: {
  buckets: readonly TimeBucket[];
  current: readonly (number | null)[];
  comparison: readonly (number | null)[] | null;
  currentLabel: string;
  comparisonLabel: string | null;
  format: (v: number) => string;
  cumulative?: boolean;
  title: string;
}) {
  const run = (vals: readonly (number | null)[]) => {
    if (!cumulative) return vals;
    let sum = 0;
    return vals.map((v) => (v === null ? null : (sum += v)));
  };
  const cur = run(current);
  const cmp = comparison ? run(comparison) : null;
  const all = [...cur, ...(cmp ?? [])].filter((v): v is number => v !== null);
  if (buckets.length === 0 || all.length === 0 || all.every((v) => v === 0)) {
    return <p className="cgx-empty">No calls in this period{comparison ? ' or its comparison' : ''} to chart.</p>;
  }
  // Sized for a card a third of a desktop wide, so axis text stays legible when scaled.
  const W = 400;
  const H = 210;
  const L = 44;
  const B = 26;
  const T = 10;
  const R = 10;
  const n = Math.max(buckets.length, cmp?.length ?? 0);
  const max = niceMax(Math.max(...all));
  const x = (i: number) => L + (n > 1 ? (i / (n - 1)) * (W - L - R) : 0);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const path = (vals: readonly (number | null)[]) => {
    const parts: string[] = [];
    let open = false;
    vals.forEach((v, i) => {
      if (v === null) { open = false; return; }
      parts.push(`${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      open = true;
    });
    return parts.join(' ');
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(n / 5));
  const lastCur = [...cur].reverse().find((v) => v !== null) ?? null;
  const lastIdx = cur.length - 1 - [...cur].reverse().findIndex((v) => v !== null);
  return (
    <figure className="cgx-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="cgx-chart__svg" role="img" aria-label={title}>
        {ticks.filter((t, i) => i === 0 || format(t) !== format(ticks[i - 1]!)).map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="cgx-chart__grid" />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" className="cgx-chart__tick">{format(t)}</text>
          </g>
        ))}
        {buckets.map((b, i) =>
          i % labelEvery === 0 ? (
            <text key={b.start.toISOString()} x={x(i)} y={H - 8} textAnchor="middle" className="cgx-chart__tick">{b.label}</text>
          ) : null,
        )}
        {cmp ? <path d={path(cmp)} className="cgx-chart__line cgx-chart__line--prior" fill="none" /> : null}
        <path d={`${path(cur)} L${x(lastIdx).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`} className="cgx-chart__area" />
        <path d={path(cur)} className="cgx-chart__line" fill="none" />
        {lastCur !== null ? <circle cx={x(lastIdx)} cy={y(lastCur)} r={3.5} className="cgx-chart__dot" /> : null}
      </svg>
      <figcaption className="cgx-chart__legend">
        <span className="cgx-legend cgx-legend--current">{currentLabel}</span>
        {comparisonLabel ? <span className="cgx-legend cgx-legend--prior">{comparisonLabel}</span> : null}
      </figcaption>
    </figure>
  );
}

/** Ranked bars: a label, a bar to scale, the value and its share of the total. */
export function BarList({
  rows, format, empty, hrefFor,
}: {
  rows: readonly { key: string; label: string; value: number | null; share: number | null }[];
  format: (v: number | null) => string;
  empty: string;
  hrefFor?: (key: string) => string;
}) {
  if (rows.length === 0) return <p className="cgx-empty">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <ul className="cgx-bars">
      {rows.map((r) => {
        const inner = (
          <>
            <span className="cgx-bars__label">{r.label}</span>
            <span className="cgx-bars__track" aria-hidden="true">
              <span className="cgx-bars__fill" style={{ width: `${Math.max(2, ((r.value ?? 0) / max) * 100)}%` }} />
            </span>
            <span className="cgx-bars__value">{format(r.value)}</span>
            <span className="cgx-bars__share">{r.share === null ? '—' : `${Math.round(r.share * 100)}%`}</span>
          </>
        );
        return (
          <li key={r.key}>
            {hrefFor ? <Link href={hrefFor(r.key)} className="cgx-bars__row">{inner}</Link> : <div className="cgx-bars__row">{inner}</div>}
          </li>
        );
      })}
    </ul>
  );
}

// --- The KPI row -------------------------------------------------------------------------------

const KPI_TONE: Record<CallGridKpi['key'], 'good' | 'accent' | 'crit' | 'neutral'> = {
  netProfit: 'good',
  revenue: 'accent',
  billableCalls: 'accent',
  margin: 'good',
  telcoCost: 'neutral',
};

export function KpiRow({ ctx }: { ctx: CommandContext }) {
  // The short name ("Yesterday"); where it was cut is stated once, under the header.
  const compare = ctx.report.comparison ? ctx.desc.comparisonTitle.split(' · ')[0] ?? null : null;
  return (
    <section className="cgx-kpis" aria-label="Key figures">
      {ctx.kpis.map((k) => (
        <Link key={k.key} href={withQuery('/app/admin/marketplace/money', ctx.query) + `#kpi-${k.key}`} className="cgx-kpi">
          <span className="cgx-kpi__label">{k.label}</span>
          <span className={'cgx-kpi__value' + (k.value === null ? ' cgx-kpi__value--none' : '')}>{kpiValue(k)}</span>
          {k.subline ? <span className="cgx-kpi__sub">{k.subline}</span> : null}
          {k.change ? (
            <span className={`cgx-kpi__change cgx-kpi__change--${k.change.favorable === null ? 'flat' : k.change.favorable ? 'good' : 'bad'}`}>
              <span aria-hidden="true">{k.change.direction === 'up' ? '↑' : k.change.direction === 'down' ? '↓' : '→'}</span> {k.change.text}
              {compare ? <span className="cgx-kpi__vs"> vs {compare}</span> : null}
            </span>
          ) : (
            <span className="cgx-kpi__change cgx-kpi__change--none">{k.noChangeReason}</span>
          )}
          {k.coverageNote ? (
            <span className="cgx-kpi__note" title={k.coverageNote}>
              Incomplete<span className="loop-sr-only">: {k.coverageNote}</span>
            </span>
          ) : null}
          <Sparkline values={k.spark} tone={KPI_TONE[k.key]} label={`${k.label} across the period`} />
        </Link>
      ))}
    </section>
  );
}

// --- The shell ---------------------------------------------------------------------------------

export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

export function CommandShell({
  ctx, active, path, executive, crumbs, children,
}: {
  ctx: CommandContext;
  active: CallGridNavKey;
  /** This page's own path, so the period controls stay on it. */
  path: string;
  /** Overview only: Today's Brief and Top Priorities. */
  executive?: ReactNode;
  /** Entity and situation pages: where the reader is inside a section. */
  crumbs?: readonly Crumb[];
  children: ReactNode;
}) {
  // Why a comparison is missing, said once: here, or -- on the Overview -- by the brief.
  const coverageNote = executive ? null : ctx.coverage.note;
  return (
    <div className="loop-os">
      <div className="cmd cg-page cgx">
        <header className="cgx-head">
          <div className="cgx-head__main">
            <p className="cgx-eyebrow">Performance</p>
            <h1 className="cgx-title">CallGrid Intelligence</h1>
            <p className="cgx-sub">Marketplace performance, what changed, and what deserves attention.</p>
          </div>
          <div className="cgx-head__side">
            <PeriodBar ctx={ctx} path={path} />
            <FreshnessBadge freshness={ctx.freshness} />
          </div>
        </header>
        {!ctx.window.isValid ? <p className="cgx-note">The requested dates were not a valid range, so today is shown.</p> : null}
        <p className={'cgx-period-line' + (coverageNote ? ' cgx-period-line--cov' : '')}>
          <span className="cgx-period-line__when">
            {ctx.desc.headerLine}
            {ctx.report.comparison && ctx.desc.comparisonNote ? <> · <span title={ctx.desc.comparisonNote}>compared with {ctx.desc.comparisonTitle}</span></> : null}
          </span>
          {coverageNote ? <span className="cgx-period-line__cov">{coverageNote}</span> : null}
        </p>
        <KpiRow ctx={ctx} />
        {executive ?? null}
        <CallGridNav active={active} rangeQuery={ctx.query} />
        {crumbs && crumbs.length > 0 ? (
          <nav className="cgx-crumbs" aria-label="Where you are">
            {crumbs.map((c, i) => (
              <span key={i} className="cgx-crumbs__item">
                {c.href ? <Link href={c.href}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}
              </span>
            ))}
          </nav>
        ) : null}
        <div className="cgx-work">{children}</div>
      </div>
    </div>
  );
}

/** A card in a workspace: a title, an optional link, and its body. */
export function Card({ title, icon, action, children, id, wide }: { title: string; icon?: ReactNode; action?: { label: string; href: string }; children: ReactNode; id?: string; wide?: boolean }) {
  return (
    <section className={'cgx-card' + (wide ? ' cgx-card--wide' : '')} aria-label={title} id={id}>
      <header className="cgx-card__head">
        <h2 className="cgx-card__title">
          {icon ? <span className="cgx-card__icon" aria-hidden="true">{icon}</span> : null}
          {title}
        </h2>
        {action ? <Link href={action.href} className="cgx-card__action">{action.label} →</Link> : null}
      </header>
      <div className="cgx-card__body">{children}</div>
    </section>
  );
}
