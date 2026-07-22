import Link from "next/link";
import type { ReactNode } from "react";
import { SidebarIcon } from "../../crm/_brand/SidebarIcon";

// EntityPage — the canonical EMG Loop drill-down.
//
// This is the PERMANENT storytelling structure for every detail/drill-down page
// in Loop. A page never invents its own layout; it maps its real data into this
// model, and the same narrative renders everywhere so every screen feels like it
// was designed by one team. The sections are fixed and always appear in this
// order — a page structurally cannot skip "why it matters":
//
//   1. Who or what is this?        -> header (eyebrow + title + subtitle)
//   2. Is it healthy?              -> health band (one plain sentence + a chip)
//   3. What changed?               -> changes
//   4. Why does it matter?         -> whyItMatters (one sentence)
//   5. What should happen next?    -> actions (+ an optional interactive primaryAction)
//   6. What evidence supports that?-> evidence (numbers behind the story, disclosed on demand)
//   7. Related work / entities     -> related (where to go from here)
//   8. What happened previously?   -> history
//
// (A listing answers "what exists?"; an entity page answers "what is the story
// of this one thing?". The two never duplicate each other.)
//
// Honesty is structural: every value the model carries is ALREADY a formatted
// string (use money/num/*OrUnknown at the call site), so this component never
// coerces an absent value to 0. Every section renders an explicit, plain-English
// empty state — never a blank or a bare "No data".
//
// Zero client JS: evidence uses native <details>. Interactive controls (forms,
// selectors) are passed in as `primaryAction` / `manage` slots by the page, so
// this stays a pure Server Component.

export type EntityTone = "good" | "warn" | "crit" | "info" | "idle";

export interface EntityHealth {
  /** Short status word: "Healthy" | "At risk" | "On track" | "Unmeasured". */
  label: string;
  tone: EntityTone;
  /** One plain sentence answering "is it healthy, and why". */
  line: string;
}

export interface EntityStat {
  label: string;
  /** Pre-formatted. Absent values must already read as "—", never "0". */
  value: string;
  tone?: EntityTone;
  hint?: string;
}

export interface EntityChange {
  label: string;
  direction: "up" | "down" | "flat";
  detail: string;
  /** Defaults from direction; set explicitly when down is good (e.g. cost). */
  tone?: EntityTone;
}

export interface EntityAction {
  title: string;
  /** Why this matters — the business stake, in plain English. */
  why: string;
  impact?: string;
  confidencePct?: number;
  href?: string;
  cta?: string;
}

export interface EntityEvidenceFact {
  statement: string;
  /** Pre-formatted value. */
  value: string;
  source?: string;
}

export interface EntityEvidence {
  label: string;
  tone?: EntityTone;
  facts: EntityEvidenceFact[];
  note?: string;
}

export interface EntityHistoryItem {
  label: string;
  detail?: string;
  /** Human, pre-formatted ("2h ago", "Jul 18"). */
  at: string;
  tone?: EntityTone;
}

export interface EntityRelatedItem {
  icon: string;
  title: string;
  detail?: string;
  href: string;
}

export interface EntityPageModel {
  // 1. Who or what is this?
  eyebrow: string;
  title: string;
  subtitle?: string;
  backHref?: string;
  backLabel?: string;
  stats?: EntityStat[];
  // 2. Is it healthy?
  health: EntityHealth;
  // 3. What changed?
  changes?: EntityChange[];
  // 4. Why does it matter?
  whyItMatters?: string;
  // 5. What should happen next?
  actions?: EntityAction[];
  primaryAction?: ReactNode;
  // 6. What evidence supports that?
  evidence?: EntityEvidence[];
  // 7. Related work / entities — where to go from here.
  related?: EntityRelatedItem[];
  // 8. What happened previously?
  history?: EntityHistoryItem[];
  // Page-specific interactive controls, grouped consistently at the end.
  manage?: ReactNode;
  manageTitle?: string;
  // Honest empty-state copy per section (each has a sensible default).
  empty?: Partial<Record<"changes" | "actions" | "evidence" | "history", string>>;
}

const CHANGE_ARROW: Record<EntityChange["direction"], string> = {
  up: "▲",
  down: "▼",
  flat: "→",
};

function changeTone(c: EntityChange): EntityTone {
  if (c.tone) return c.tone;
  return c.direction === "up" ? "good" : c.direction === "down" ? "crit" : "idle";
}

function Empty({ line }: { line: string }) {
  return <p className="ent-empty">{line}</p>;
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="ent-card" aria-label={title}>
      <div className="ent-card__head">
        <h2 className="ent-card__title">{title}</h2>
        {typeof count === "number" && count > 0 ? <span className="ent-count">{count}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function EntityPage({ model }: { model: EntityPageModel }) {
  const {
    eyebrow, title, subtitle, backHref, backLabel, stats, health,
    changes = [], whyItMatters, actions = [], primaryAction,
    evidence = [], related = [], history = [], manage, manageTitle, empty = {},
  } = model;

  return (
    <div className="loop-os loop-os--v3 loop-os--v4 loop-os--v5">
      <main className="loop-os__main ent">

        {/* 1. WHO OR WHAT IS THIS? */}
        <header className="ent-head">
          <div className="ent-head__main">
            {backHref ? (
              <Link href={backHref} className="ent-back">
                <span aria-hidden="true">←</span> {backLabel ?? "Back"}
              </Link>
            ) : null}
            <p className="ent-eyebrow">{eyebrow}</p>
            <h1 className="ent-title">{title}</h1>
            {subtitle ? <p className="ent-sub">{subtitle}</p> : null}
          </div>
          <div className="ent-head__side">
            <span className={"ent-health ent-health--" + health.tone}>{health.label}</span>
          </div>
        </header>

        {/* 2. IS IT HEALTHY? */}
        <section className={"ent-band ent-band--" + health.tone} aria-label="Health">
          <span className="ent-band__eyebrow">Health</span>
          <p className="ent-band__line">{health.line}</p>
        </section>

        {/* Identity facts — supporting context, doorways not a metric wall. */}
        {stats && stats.length > 0 ? (
          <div className="ent-stats">
            {stats.map((s, i) => (
              <div className={"ent-stat" + (s.tone ? " ent-stat--" + s.tone : "")} key={i}>
                <span className="ent-stat__value">{s.value}</span>
                <span className="ent-stat__label">{s.label}</span>
                {s.hint ? <span className="ent-stat__hint">{s.hint}</span> : null}
              </div>
            ))}
          </div>
        ) : null}

        <div className="ent-grid">
          <div className="ent-grid__main">

            {/* 3. WHAT CHANGED? */}
            <Section title="What changed" count={changes.length}>
              {changes.length > 0 ? (
                <ul className="ent-changes">
                  {changes.map((c, i) => (
                    <li className={"ent-change ent-change--" + changeTone(c)} key={i}>
                      <span className="ent-change__arrow">{CHANGE_ARROW[c.direction]}</span>
                      <span className="ent-change__label">{c.label}</span>
                      <span className="ent-change__detail">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty line={empty.changes ?? "Nothing has changed here since the last time this was measured."} />
              )}
            </Section>

            {/* 4. WHY DOES IT MATTER? */}
            {whyItMatters ? (
              <section className="ent-card ent-why" aria-label="Why it matters">
                <span className="ent-why__eyebrow">Why it matters</span>
                <p className="ent-why__line">{whyItMatters}</p>
              </section>
            ) : null}

            {/* 5. WHAT SHOULD HAPPEN NEXT? */}
            <Section title="What should happen next">
              {primaryAction ? <div className="ent-primary">{primaryAction}</div> : null}
              {actions.length > 0 ? (
                <ul className="ent-actions">
                  {actions.map((a, i) => (
                    <li className="ent-action" key={i}>
                      <div className="ent-action__main">
                        <span className="ent-action__title">{a.title}</span>
                        <p className="ent-action__why">{a.why}</p>
                        {a.impact || typeof a.confidencePct === "number" ? (
                          <div className="ent-action__meta">
                            {a.impact ? <span className="ent-action__impact">Expected: {a.impact}</span> : null}
                            {typeof a.confidencePct === "number" ? (
                              <span className="ent-action__conf">{a.confidencePct}% confidence</span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      {a.href ? (
                        <Link href={a.href} className="ent-btn ent-btn--ghost">{a.cta ?? "Open"}</Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : !primaryAction ? (
                <Empty line={empty.actions ?? "Nothing needs a decision here right now."} />
              ) : null}
            </Section>

            {/* 6. WHAT EVIDENCE SUPPORTS THAT? — disclosed on demand. */}
            <Section title="The evidence" count={evidence.length}>
              {evidence.length > 0 ? (
                <ul className="ent-ev">
                  {evidence.map((e, i) => (
                    <li className={"ent-ev__item" + (e.tone ? " ent-ev__item--" + e.tone : "")} key={i}>
                      <details className="ent-ev__disc">
                        <summary className="ent-ev__summary">
                          <span className="ent-ev__label">{e.label}</span>
                          <span className="ent-ev__hint">{e.facts.length} fact{e.facts.length === 1 ? "" : "s"}</span>
                        </summary>
                        <ul className="ent-ev__facts">
                          {e.facts.map((f, j) => (
                            <li className="ent-ev__fact" key={j}>
                              <span className="ent-ev__stmt">{f.statement}</span>
                              <span className="ent-ev__val">{f.value}</span>
                              {f.source ? <span className="ent-ev__src">{f.source}</span> : null}
                            </li>
                          ))}
                        </ul>
                        {e.note ? <p className="ent-ev__note">{e.note}</p> : null}
                      </details>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty line={empty.evidence ?? "The evidence behind this is not available yet."} />
              )}
            </Section>

            {/* 7. RELATED WORK / ENTITIES — where to go from here. */}
            {related.length > 0 ? (
              <Section title="Related">
                <ul className="ent-related">
                  {related.map((r, i) => (
                    <li key={i}>
                      <Link href={r.href} className="ent-related__item">
                        <span className="ent-related__icon"><SidebarIcon name={r.icon} /></span>
                        <div className="ent-related__text">
                          <span className="ent-related__title">{r.title}</span>
                          {r.detail ? <span className="ent-related__detail">{r.detail}</span> : null}
                        </div>
                        <span className="ent-related__arrow" aria-hidden="true">→</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {/* Page-specific interactive controls, grouped consistently. */}
            {manage ? (
              <Section title={manageTitle ?? "Manage"}>
                {manage}
              </Section>
            ) : null}
          </div>

          {/* 7. WHAT HAPPENED PREVIOUSLY? */}
          <aside className="ent-grid__rail">
            <Section title="What happened previously" count={history.length}>
              {history.length > 0 ? (
                <ol className="ent-hist">
                  {history.map((h, i) => (
                    <li className={"ent-hist__item ent-hist__item--" + (h.tone ?? "idle")} key={i}>
                      <span className="ent-hist__dot" aria-hidden="true" />
                      <div className="ent-hist__body">
                        <span className="ent-hist__label">{h.label}</span>
                        {h.detail ? <span className="ent-hist__detail">{h.detail}</span> : null}
                        <span className="ent-hist__at">{h.at}</span>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="ent-hist__empty">
                  <span className="ent-hist__icon"><SidebarIcon name="activity" /></span>
                  <Empty line={empty.history ?? "No history recorded yet. Events appear here as they happen."} />
                </div>
              )}
            </Section>
          </aside>
        </div>
      </main>
    </div>
  );
}
