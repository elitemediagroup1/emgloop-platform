// The record grammar of Charlie and Lexi's handoff (2026-09-16, p. 5), as primitives.
//
// Page zones: a context header (trail, subject, state, actions), context navigation
// (tabs), a primary workspace with a supporting rail, a context drawer, and one
// family of non-default states. Everything renders on the light record canvas
// (`.lx`, loop-os.css). Server components only; the drawer is a native disclosure.
//
// RULES:
//   - An unavailable capability is never a link. A tab, action or summary value
//     that has no authority behind it says so and goes nowhere.
//   - Unknown is shown as unknown, never as zero or a dash that reads as zero.
//   - Loading, empty, unavailable, error and not-permitted are different blocks
//     with different words.

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { SubjectState } from '../../../crm/subject-display';

export function LxPage({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="lx" aria-label={label}>
      <div className="lx-inner">{children}</div>
    </div>
  );
}

export interface TrailStep {
  readonly label: string;
  readonly href?: string | null;
}

/** Navigation state only: how the person got here. It never creates a relationship. */
export function ContextTrail({ steps }: { steps: readonly TrailStep[] }) {
  return (
    <nav aria-label="Context trail">
      <p className="lx-trail">
        {steps.map((step, i) => (
          <span key={`${step.label}-${i}`}>
            {i > 0 ? <span className="lx-trail__sep" aria-hidden="true">/ </span> : null}
            {step.href && i < steps.length - 1 ? <Link href={step.href}>{step.label}</Link> : <span aria-current={i === steps.length - 1 ? 'page' : undefined}>{step.label}</span>}
          </span>
        ))}
      </p>
    </nav>
  );
}

export function PageHead(props: {
  trail: readonly TrailStep[];
  /** Absent when the page's heading is its featured subject block. */
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="lx-head">
      <div className="lx-head__text">
        <ContextTrail steps={props.trail} />
        {props.title ? <h1 className="lx-title">{props.title}</h1> : null}
        {props.subtitle ? <p className="lx-subtitle">{props.subtitle}</p> : null}
      </div>
      {props.actions ? <div className="lx-head__actions">{props.actions}</div> : null}
    </header>
  );
}

export function StatePill({ state }: { state: SubjectState }) {
  return <span className={`lx-pill lx-pill--${state.tone}`}>{state.label}</span>;
}

export interface ActionSpec {
  readonly label: string;
  /** Null: the action is not available to this person; `reason` says why. */
  readonly href: string | null;
  readonly reason?: string;
  readonly primary?: boolean;
}

/** An action that exists only when it can be taken. Otherwise a labelled, inert control. */
export function ActionButton({ action }: { action: ActionSpec }) {
  const cls = 'lx-btn' + (action.primary ? ' lx-btn--primary' : '');
  if (action.href) {
    return (
      <Link className={cls} href={action.href}>
        {action.label}
      </Link>
    );
  }
  return (
    <span className="lx-btn" role="link" aria-disabled="true" title={action.reason}>
      {action.label}
      {action.reason ? <span className="lx-visually-hidden">. {action.reason}</span> : null}
    </span>
  );
}

export interface TabSpec {
  readonly label: string;
  /** Null: the capability behind the tab does not exist yet. Never a link. */
  readonly href: string | null;
  readonly current?: boolean;
  readonly reason?: string;
}

export function ContextTabs({ label, tabs }: { label: string; tabs: readonly TabSpec[] }) {
  return (
    <nav className="lx-tabs" aria-label={label}>
      {tabs.map((tab) =>
        tab.href ? (
          <Link key={tab.label} className="lx-tab" href={tab.href} aria-current={tab.current ? 'page' : undefined}>
            {tab.label}
          </Link>
        ) : (
          <span key={tab.label} className="lx-tab lx-tab--unavailable" aria-disabled="true" title={tab.reason}>
            {tab.label}
            <span className="lx-tab__soon">Not yet</span>
          </span>
        ),
      )}
    </nav>
  );
}

export interface StripItem {
  readonly label: string;
  /** Null: Loop cannot say. Rendered as the reason, never as zero. */
  readonly value: string | null;
  readonly unknownText?: string;
}

export function SummaryStrip({ items, label }: { items: readonly StripItem[]; label: string }) {
  return (
    <section className="lx-strip" aria-label={label}>
      {items.map((item) => (
        <div className="lx-strip__item" key={item.label}>
          <span className="lx-strip__label">{item.label}</span>
          {item.value === null ? (
            <span className="lx-strip__value lx-strip__value--unknown">{item.unknownText ?? 'Not available yet'}</span>
          ) : (
            <span className="lx-strip__value">{item.value}</span>
          )}
        </div>
      ))}
    </section>
  );
}

export function RecordLayout({ main, rail, railLabel }: { main: ReactNode; rail: ReactNode; railLabel: string }) {
  return (
    <div className="lx-record">
      <div className="lx-record__main">{main}</div>
      <aside className="lx-record__rail" aria-label={railLabel}>
        {rail}
      </aside>
    </div>
  );
}

export function Panel({ title, children, lead }: { title: string; children?: ReactNode; lead?: string }) {
  return (
    <section className="lx-panel" aria-label={title}>
      <h2 className="lx-panel__title">{title}</h2>
      {lead ? <p className="lx-panel__lead">{lead}</p> : null}
      {children}
    </section>
  );
}

export interface FactRow {
  readonly label: string;
  /** Null: not known. `unknownText` says what that means here. */
  readonly value: ReactNode | null;
  readonly unknownText?: string;
}

export function Facts({ rows }: { rows: readonly FactRow[] }) {
  return (
    <dl className="lx-facts">
      {rows.map((row) => (
        <div key={row.label} style={{ display: 'contents' }}>
          <dt>{row.label}</dt>
          {row.value === null ? <dd className="is-unknown">{row.unknownText ?? 'Unknown'}</dd> : <dd>{row.value}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** Evidence, participants or audit detail without leaving the subject. A full-screen sheet on phones. */
export function ContextDrawer({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="lx-drawer">
      <summary>{summary}</summary>
      <div className="lx-drawer__body">{children}</div>
    </details>
  );
}

export type StateKind = 'empty' | 'unavailable' | 'error' | 'denied' | 'attention';

const STATE_MARK: Record<StateKind, string> = {
  empty: '○',
  unavailable: '◌',
  error: '!',
  denied: '⊘',
  attention: '◑',
};

/**
 * The non-default states, kept apart:
 *   empty        Loop looked and there is nothing (yet).
 *   unavailable  The capability or projection does not exist yet; nothing was looked at.
 *   error        Loop tried to read and could not. Not a finding.
 *   denied       This person may not see it.
 *   attention    Something needs a person, with a way to act.
 */
export function StateBlock(props: {
  kind: StateKind;
  title: string;
  body: string;
  action?: ActionSpec;
  compact?: boolean;
}) {
  const role = props.kind === 'error' ? 'alert' : undefined;
  return (
    <div
      className={`lx-state lx-state--${props.kind}` + (props.compact ? ' lx-state--compact' : '')}
      role={role}
      data-state={props.kind}
    >
      <span className="lx-state__mark" aria-hidden="true">
        {STATE_MARK[props.kind]}
      </span>
      <div>
        <p className="lx-state__title">{props.title}</p>
        <p className="lx-state__body">{props.body}</p>
        {props.action ? (
          <div className="lx-state__action">
            <ActionButton action={props.action} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The read failed. Loop says so, and says it is not evidence of an empty list. */
export function ReadFailed({ what }: { what: string }) {
  return (
    <StateBlock
      kind="error"
      title={`Loop could not load ${what}.`}
      body={`This is a failure to read, not a finding: it does not mean there are no ${what}. Try again shortly.`}
    />
  );
}

/** The loading shape of a list page, drawn on the record canvas. */
export function ListSkeleton({ trail, rows = 5 }: { trail: string; rows?: number }) {
  return (
    <LxPage>
      <div aria-busy="true" aria-live="polite">
        <p className="lx-trail">{trail}</p>
        <span className="lx-skel lx-skel--title" />
        <span className="lx-visually-hidden">Loading</span>
      </div>
      <div className="lx-stack">
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} className="lx-skel lx-skel--row" />
        ))}
      </div>
    </LxPage>
  );
}
