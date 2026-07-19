import Link from "next/link";
import { SidebarIcon } from "../../crm/_brand/SidebarIcon";
import type { Tone, Ranked } from "./types";
import { moneyOrUnknown, numOrUnknown } from "./format";
import { StatusDot } from "./primitives";

export function Module(props: {
  icon: string;
  title: string;
  metric: string;
  unit?: string;
  detail: string;
  tone: Tone;
  href: string;
  seed?: number; // Sprint 27: retained for callers; no longer renders a chart
}) {
  return (
    <Link href={props.href} className="loop-mod" aria-label={props.title}>
      <div className="loop-mod__top">
        <span className="loop-mod__icon"><SidebarIcon name={props.icon} /></span>
        <span className="loop-mod__name">{props.title}</span>
        <StatusDot tone={props.tone} />
      </div>
      <div className="loop-mod__metric">
        <span className="loop-mod__value">{props.metric}</span>
        {props.unit ? <span className="loop-mod__unit">{props.unit}</span> : null}
      </div>
      <div className="loop-mod__detail">{props.detail}</div>
    </Link>
  );
}

export function Bar(props: { label: string; value: string; pct: number; tone: Tone }) {
  const w = Math.max(0, Math.min(100, props.pct));
  return (
    <div className="loop-bar">
      <div className="loop-bar__head">
        <span className="loop-bar__label">{props.label}</span>
        <span className="loop-bar__value">{props.value}</span>
      </div>
      <div className="loop-bar__track">
        <div className={"loop-bar__fill loop-bar__fill--" + props.tone} style={{ width: w + "%" }} />
      </div>
    </div>
  );
}

export function RankedList(props: { icon: string; title: string; rows: Ranked[]; metric: "revenue" | "orders" }) {
  const rows = (props.rows || []).slice(0, 5);
  return (
    <div className="loop-rank">
      <div className="loop-rank__head">
        <span className="loop-rank__icon"><SidebarIcon name={props.icon} /></span>
        <span className="loop-rank__title">{props.title}</span>
      </div>
      {rows.length === 0 ? (
        <div className="loop-rank__empty">No data yet</div>
      ) : (
        <ol className="loop-rank__list">
          {rows.map((r, i) => (
            <li key={(r.key || r.label || "") + i} className="loop-rank__item">
              <span className="loop-rank__pos">{i + 1}</span>
              <span className="loop-rank__name">{r.label || "Unknown"}</span>
              <span className="loop-rank__num">
                {/* A ranked row may carry no revenue/order figure at all. That is
                    unknown, not zero — render it as such. */}
                {props.metric === "revenue" ? moneyOrUnknown(r.revenueCents) : numOrUnknown(r.orders)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
