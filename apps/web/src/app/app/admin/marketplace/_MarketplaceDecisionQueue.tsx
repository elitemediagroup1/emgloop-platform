import Link from "next/link";
import { AttentionRow, num } from "../../_loop-os";
import type { Tone } from "../../_loop-os";

export type MarketplaceDecisionItem = {
  icon: string;
  tone: Tone;
  title: string;
  detail: string;
};

export function MarketplaceDecisionQueue(props: {
  items: MarketplaceDecisionItem[];
  reviewHref: string;
  title?: string;
  emptyBody?: string;
}) {
  const items = props.items || [];
  const title = props.title || "Decision queue";
  const emptyBody =
    props.emptyBody || "Nothing is surfaced by the current data.";
  return (
    <div className="loop-card">
      <div className="loop-card__head">
        <span className="loop-card__title">{title}</span>
        {items.length > 0 ? (
          <span className="loop-badge loop-badge--idle">{num(items.length)}</span>
        ) : null}
      </div>
      {items.length > 0 ? (
        <div className="loop-attn">
          {items.map((d, i) => (
            <AttentionRow
              key={i}
              icon={d.icon}
              tone={d.tone}
              title={d.title}
              detail={d.detail}
              href={props.reviewHref}
            />
          ))}
        </div>
      ) : (
        <div className="loop-empty loop-empty--good">
          <p className="loop-empty__title">Nothing needs review</p>
          <p className="loop-empty__body">{emptyBody}</p>
        </div>
      )}
    </div>
  );
}
