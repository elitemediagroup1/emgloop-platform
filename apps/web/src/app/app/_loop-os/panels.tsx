import Link from "next/link";
import { SidebarIcon } from "../../crm/_brand/SidebarIcon";
import type { QueryCoverage } from "@emgloop/database";
import type { Tone } from "./types";

export function AttentionRow(props: { icon: string; tone: Tone; title: string; detail: string; href: string }) {
  return (
    <div className="loop-attn__row">
      <span className={"loop-attn__icon loop-attn__icon--" + props.tone}><SidebarIcon name={props.icon} /></span>
      <div className="loop-attn__text">
        <div className="loop-attn__title">{props.title}</div>
        <div className="loop-attn__detail">{props.detail}</div>
      </div>
      <Link href={props.href} className="loop-attn__cta">Review <span aria-hidden="true">{"\u2192"}</span></Link>
    </div>
  );
}

export function BriefingItem(props: { icon: string; title: string }) {
  return (
    <div className="loop-brief__item">
      <span className="loop-brief__icon"><SidebarIcon name={props.icon} /></span>
      <div className="loop-brief__text">
        <div className="loop-brief__title">{props.title}</div>
        <div className="loop-brief__wait">Waiting for today's briefing.</div>
      </div>
    </div>
  );
}

/**
 * Honest partial-data notice for a bounded aggregate read.
 *
 * The revenue/traffic scans are capped to prevent the serverless
 * Runtime.OutOfMemory crash they used to cause. When a cap binds, the totals on
 * the page are a LOWER BOUND over the scanned slice — this banner exists so
 * they are never read as final. Renders nothing when every coverage is
 * complete, so a healthy page is unchanged.
 *
 * Accepts several coverages because most pages read revenue AND traffic; they
 * merge into one banner rather than stacking two. Nulls are tolerated so a page
 * whose read failed (loadOrFallback) can pass its value through directly.
 */
export function PartialDataNotice(props: {
  coverage: QueryCoverage | null | undefined | ReadonlyArray<QueryCoverage | null | undefined>;
}) {
  const list = (Array.isArray(props.coverage) ? props.coverage : [props.coverage]).filter(
    (c): c is QueryCoverage => Boolean(c) && !c!.complete,
  );
  if (list.length === 0) return null;

  // Both reads share cap wording, so identical reasons would otherwise repeat.
  const reasons = Array.from(new Set(list.flatMap((c) => c.reasons)));
  const rowsScanned = list.reduce((sum, c) => sum + c.rowsScanned, 0);

  return (
    <div className="loop-banner loop-banner--warn" role="status">
      <span className="loop-banner__glyph"><SidebarIcon name="bell" /></span>
      <div className="loop-banner__text">
        <div className="loop-banner__title">Partial data — these totals are incomplete</div>
        <div className="loop-banner__body">
          {reasons.join(" ")} Scanned {rowsScanned.toLocaleString()} rows. Figures are
          a lower bound, capped to keep this page within its memory budget.
        </div>
      </div>
    </div>
  );
}

export function IntegrationPill(props: { name: string; state: "connected" | "needs" | "error" }) {
  const label = props.state === "connected" ? "Connected" : props.state === "error" ? "Error" : "Needs Setup";
  return (
    <div className={"loop-intg__pill loop-intg__pill--" + props.state}>
      <span className="loop-intg__dot" aria-hidden="true" />
      <span className="loop-intg__name">{props.name}</span>
      <span className="loop-intg__state">{label}</span>
    </div>
  );
}
