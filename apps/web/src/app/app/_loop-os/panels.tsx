import Link from "next/link";
import { SidebarIcon } from "../../crm/_brand/SidebarIcon";
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
