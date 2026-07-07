import Link from "next/link";
import { SidebarIcon } from "../../crm/_brand/SidebarIcon";
import { IntegrationPill } from "./panels";
import { connectionLabel } from "../../../crm/integration-os";
import type { ProviderCard, SystemHealth } from "../../../crm/integration-os";

type PillState = "connected" | "needs" | "error";

interface DerivedPill {
  name: string;
  state: PillState;
  hint: string;
}

function deriveState(card: ProviderCard): PillState {
  const conn = card && card.status ? card.status.connection : "not_configured";
  const label = String(connectionLabel(conn) || "").toLowerCase();
  if (label.indexOf("error") >= 0 || label.indexOf("fail") >= 0) return "error";
  if (label.indexOf("connect") >= 0 && label.indexOf("not") < 0) return "connected";
  return "needs";
}

function providerName(card: ProviderCard): string {
  const spec = card ? card.spec : undefined;
  return (spec && (spec.displayName || spec.id)) || "Provider";
}

function nextStep(card: ProviderCard, state: PillState): string {
  if (state === "connected") return "";
  const status = card ? card.status : undefined;
  const missing = status && status.missingRequiredSecrets ? status.missingRequiredSecrets : [];
  if (state === "error") return "Check the connection to restore this provider.";
  if (missing.length > 0) return "Add " + missing.join(", ") + " to finish setup.";
  return "Finish connecting to unlock this provider.";
}

function derive(cards: ProviderCard[]): DerivedPill[] {
  const list = Array.isArray(cards) ? cards : [];
  return list.map((card) => {
    const state = deriveState(card);
    return { name: providerName(card), state, hint: nextStep(card, state) };
  });
}

export function IntegrationStatusPanel(props: {
  cards: ProviderCard[];
  health: SystemHealth | null;
  href?: string;
  title?: string;
  viewAllLabel?: string;
  limit?: number;
}) {
  const pills = derive(props.cards);
  const connected = pills.filter((p) => p.state === "connected");
  const errored = pills.filter((p) => p.state === "error");
  const needs = pills.filter((p) => p.state === "needs");
  const health = props.health;
  const connectedCount = health ? health.connected : connected.length;
  const needsCount = health ? health.needsSetup : needs.length;
  const errorCount = health ? health.errors : errored.length;
  const limit = typeof props.limit === "number" ? props.limit : 6;
  // Attention first: errors, then needs setup, then connected.
  const ordered = errored.concat(needs, connected).slice(0, limit);
  const title = props.title || "Integration Status";
  const viewAllLabel = props.viewAllLabel || "View all";
  const hasCards = pills.length > 0;

  return (
    <div className="loop-intg">
      <div className="loop-intg__head">
        <h3 className="loop-intg__title">{title}</h3>
        {props.href ? (
          <Link href={props.href} className="loop-intg__all">
            {viewAllLabel}
          </Link>
        ) : null}
      </div>

      <div className="loop-intg__summary">
        <span className="loop-intg__stat loop-intg__stat--connected">
          {connectedCount} connected
        </span>
        <span className="loop-intg__stat loop-intg__stat--needs">
          {needsCount} needs setup
        </span>
        <span className="loop-intg__stat loop-intg__stat--error">
          {errorCount} errors
        </span>
      </div>

      {hasCards ? (
        <div className="loop-intg__grid">
          {ordered.map((p, i) => (
            <div className="loop-intg__row" key={p.name + i}>
              <IntegrationPill name={p.name} state={p.state} />
              {p.hint ? <p className="loop-intg__next">{p.hint}</p> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="loop-empty">
          <span className="loop-empty__icon" aria-hidden="true">
            <SidebarIcon name="plug" />
          </span>
          <p className="loop-empty__title">No providers configured</p>
          <p className="loop-empty__body">
            Connected providers and their status will appear here.
          </p>
        </div>
      )}
    </div>
  );
}
