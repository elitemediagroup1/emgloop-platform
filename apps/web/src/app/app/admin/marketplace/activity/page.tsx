import Link from "next/link";
import { MarketplaceNav } from "../_MarketplaceNav";
import { MarketplaceDecisionQueue } from "../_MarketplaceDecisionQueue";
import type { MarketplaceDecisionItem } from "../_MarketplaceDecisionQueue";
import { SidebarIcon } from "../../../../crm/_brand/SidebarIcon";
import { loadOrFallback } from "../../../../../demo/db-health";
import { crmRepos, requireCrmContext } from "../../../../../crm/crm-data";
import { loadProviderCards, computeSystemHealth, connectionLabel } from "../../../../../crm/integration-os";
import {
  num,
  relTime,
  clockDuration,
  todayLabel,
  IntegrationStatusPanel,
  ContextGroup,
} from "../../../_loop-os";

export const dynamic = "force-dynamic";

type Pill = { name: string; state: "connected" | "needs" | "error" };

type ActivityKind =
  | "website"
  | "call"
  | "workflow"
  | "customer"
  | "booking"
  | "integration";

type FeedEvent = {
  id: string;
  kind: ActivityKind;
  group: string;
  icon: string;
  pill: string;
  pillTone: string;
  title: string;
  detail: string | null;
  at: string;
  related: string | null;
};

export default async function MarketplaceActivityPage() {
  const { organizationId: org } = await requireCrmContext();
  const liveActivityR = org
    ? await loadOrFallback(async () => crmRepos.liveOperations.listLiveActivity(org))
    : { ok: false as const };
  const liveCallsR = org
    ? await loadOrFallback(async () => crmRepos.liveOperations.listLiveCalls(org))
    : { ok: false as const };
  const integrationsR = org
    ? await loadOrFallback(async () => loadProviderCards(org))
    : { ok: false as const };

  const liveActivity = liveActivityR.ok ? liveActivityR.data : [];
  const liveCalls = liveCallsR.ok ? liveCallsR.data : [];
  const cards = integrationsR.ok ? integrationsR.data : [];
  const health = computeSystemHealth(cards || []);

  const pills: Pill[] = (cards || []).map((card: any) => {
    const name = (card && card.spec && (card.spec.displayName || card.spec.name)) || "Provider";
    const conn = card && card.status ? card.status.connection : undefined;
    const label = String(connectionLabel(conn) || "").toLowerCase();
    let state: "connected" | "needs" | "error" = "needs";
    if (label.indexOf("error") >= 0 || label.indexOf("fail") >= 0) state = "error";
    else if (label.indexOf("connect") >= 0 && label.indexOf("not") < 0) state = "connected";
    return { name, state };
  });
  const needsPills = pills.filter((p) => p.state === "needs");
  const errorPills = pills.filter((p) => p.state === "error");

  type MetaEntry = { group: string; icon: string; pill: string; tone: string };
  const DEFAULT_META: MetaEntry = {
    group: "Marketplace",
    icon: "grid",
    pill: "System",
    tone: "system",
  };
  const KIND_META: Record<string, MetaEntry> = {
    website: { group: "Marketplace", icon: "grid", pill: "System", tone: "system" },
    call: { group: "Live Call", icon: "chart", pill: "Call", tone: "call" },
    workflow: { group: "Operations", icon: "flow", pill: "System", tone: "system" },
    customer: { group: "Buyer", icon: "users", pill: "Buyer", tone: "buyer" },
    booking: { group: "Revenue", icon: "revenue", pill: "Booking", tone: "booking" },
    integration: { group: "Integration", icon: "plug", pill: "Integration", tone: "integration" },
  };

  const feed: FeedEvent[] = (liveActivity || []).map((a) => {
    const meta =
      (KIND_META[a.kind] as MetaEntry | undefined) || DEFAULT_META;
    return {
      id: a.id,
      kind: a.kind,
      group: meta.group,
      icon: meta.icon,
      pill: meta.pill,
      pillTone: meta.tone,
      title: a.label || a.eventType || "Marketplace event",
      detail: a.detail,
      at: a.at,
      related: a.provider,
    };
  });

  const hasFeed = feed.length > 0;
  const lastEvent = feed.length > 0 ? feed[0]! : null;
  const todayCutoff = new Date();
  todayCutoff.setHours(0, 0, 0, 0);
  const activityToday = feed.filter((e) => {
    const t = new Date(e.at);
    return !isNaN(t.getTime()) && t.getTime() >= todayCutoff.getTime();
  }).length;
  const liveNow = liveCalls.filter((c) => {
    const s = (c.status || "").toLowerCase();
    return s.indexOf("connect") >= 0 || s.indexOf("live") >= 0 || s.indexOf("progress") >= 0;
  }).length;

  const groupsOrder = ["Marketplace", "Revenue", "Buyer", "Integration", "Operations", "Live Call"];
  const grouped = groupsOrder
    .map((g) => ({ group: g, items: feed.filter((e) => e.group === g) }))
    .filter((g) => g.items.length > 0);

  const FILTERS = [
    "All",
    "Marketplace",
    "Campaigns",
    "Buyers",
    "Sources",
    "Vendors",
    "Calls",
    "Integrations",
  ];

  const decisions: MarketplaceDecisionItem[] = [];
  if (errorPills.length > 0) {
    decisions.push({
      icon: "plug",
      tone: "crit",
      title: errorPills.length + " integration error" + (errorPills.length === 1 ? "" : "s"),
      detail: "Some providers report errors and may need attention.",
    });
  }
  if (needsPills.length > 0) {
    decisions.push({
      icon: "plug",
      tone: "warn",
      title: needsPills.length + " provider" + (needsPills.length === 1 ? "" : "s") + " need setup",
      detail: "Finish connecting providers to complete marketplace visibility.",
    });
  }

  return (
    <div className="loop-os loop-os--v3 loop-os--v4 loop-os--v5">
      <div className="loop-os__main">
        <header className="loop-os__brief">
          <div className="loop-os__brief-main">
            <p className="loop-os__brief-lead">Marketplace</p>
            <h1 className="loop-os__brief-title">Marketplace Activity</h1>
            <p className="loop-os__brief-body">
              A real-time chronological view of marketplace operations.
            </p>
            <Link href="/app/admin/marketplace" className="loop-os__brief-cta">
              Back to marketplace <span aria-hidden="true">&rarr;</span>
            </Link>
          </div>
          <div className="loop-os__brief-chip">
            <SidebarIcon name="calendar" />
            <span className="loop-os__brief-chiptoday">Today</span>
            <span className="loop-os__brief-chipdate">{todayLabel()}</span>
          </div>
        </header>

        <MarketplaceNav active="activity" />

        <section className="loop-actv__summary" aria-label="Activity summary">
          <div className="loop-actv__sum">
            <span className="loop-actv__sumlabel">Last event</span>
            <span className="loop-actv__sumvalue">
              {lastEvent ? relTime(lastEvent.at) : "No events"}
            </span>
            <span className="loop-actv__sumsub">
              {lastEvent ? lastEvent.group : "No activity yet"}
            </span>
          </div>
          <div className="loop-actv__sum">
            <span className="loop-actv__sumlabel">Activity today</span>
            <span className="loop-actv__sumvalue">{num(activityToday)}</span>
            <span className="loop-actv__sumsub">events recorded</span>
          </div>
          <div className="loop-actv__sum">
            <span className="loop-actv__sumlabel">Live calls</span>
            <span className="loop-actv__sumvalue">{num(liveNow)}</span>
            <span className="loop-actv__sumsub">in progress now</span>
          </div>
          <div className="loop-actv__sum">
            <span className="loop-actv__sumlabel">Marketplace health</span>
            <span className="loop-actv__sumvalue">{num(health.overallPercent)}%</span>
            <span className="loop-actv__sumsub">
              {num(health.connected)} connected
            </span>
          </div>
        </section>

        <div className="loop-actv__filters" aria-label="Activity filters">
          {FILTERS.map((f, i) => (
            <span
              key={f}
              className={
                i === 0
                  ? "loop-actv__filter loop-actv__filter--active"
                  : "loop-actv__filter"
              }
            >
              {f}
            </span>
          ))}
        </div>

        <div className="loop-grid">
          <div className="loop-grid__content">
            <section className="loop-card">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Activity feed</h2>
                <span className="loop-count">{num(feed.length)} events</span>
              </div>
              {hasFeed ? (
                <div className="loop-actv__timeline">
                  {grouped.map((g) => (
                    <div className="loop-actv__group" key={g.group}>
                      <div className="loop-actv__grouphead">{g.group}</div>
                      {g.items.map((e) => (
                        <div className="loop-actv__event" key={e.id}>
                          <div className="loop-actv__rail">
                            <span className="loop-actv__icon">
                              <SidebarIcon name={e.icon} />
                            </span>
                            <span className="loop-actv__connector" aria-hidden="true" />
                          </div>
                          <div className="loop-actv__body">
                            <span className="loop-actv__title">{e.title}</span>
                            {e.detail ? (
                              <span className="loop-actv__desc">{e.detail}</span>
                            ) : null}
                            <div className="loop-actv__meta">
                              <span className={"loop-pill loop-pill--" + e.pillTone}>
                                {e.pill}
                              </span>
                              {e.related ? (
                                <span className="loop-actv__rel">{e.related}</span>
                              ) : null}
                            </div>
                          </div>
                          <div className="loop-actv__side">
                            <span className="loop-actv__time">{relTime(e.at)}</span>
                            <Link
                              href="/app/admin/marketplace"
                              className="loop-actv__view"
                            >
                              View
                            </Link>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="loop-empty">
                  <p className="loop-empty__title">No marketplace activity yet</p>
                  <p className="loop-empty__body">
                    Marketplace activity will appear here as events are processed.
                  </p>
                </div>
              )}
            </section>

            <section className="loop-card">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Live calls</h2>
                <span className="loop-count">{num(liveCalls.length)}</span>
              </div>
              {liveCalls.length > 0 ? (
                <ul className="loop-feed__list">
                  {liveCalls.slice(0, 8).map((c, i) => (
                    <li className="loop-feed__item" key={i}>
                      <span className="loop-feed__dot" aria-hidden="true" />
                      <span className="loop-feed__phone">
                        {c.caller || "Unknown caller"}
                      </span>
                      <span className="loop-actv__rel">{c.status || "Live"}</span>
                      <span className="loop-feed__time">
                        {clockDuration(c.durationSeconds)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="loop-empty">
                  <p className="loop-empty__title">No live calls right now</p>
                  <p className="loop-empty__body">
                    Active calls will appear here while the marketplace is in motion.
                  </p>
                </div>
              )}
            </section>
          </div>

          <aside className="loop-rail">
            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Shortcuts</span>
              </div>
              <div className="loop-brief">
                <Link className="loop-card__link" href="/app/admin/work">My Work {"\u2192"}</Link>
                <Link className="loop-card__link" href="/app/admin/marketplace">Marketplace overview</Link>
                <Link className="loop-card__link" href="/app/admin/marketplace/campaigns">Campaigns</Link>
                <Link className="loop-card__link" href="/app/admin/marketplace/buyers">Buyers</Link>
                <Link className="loop-card__link" href="/app/admin/marketplace/sources">Sources / Publishers</Link>
                <Link className="loop-card__link" href="/app/admin/marketplace/vendors">Vendors</Link>
              </div>
            </div>

            <MarketplaceDecisionQueue
              items={decisions}
              reviewHref="/app/admin/marketplace"
              emptyBody="No marketplace decisions are supported by the current data."
            />

            <section className="loop-card loop-intg-panel">
              <IntegrationStatusPanel cards={cards} health={health} href="/app/admin/integrations" />
            </section>

            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Brain</span>
                <span className="loop-badge loop-badge--idle">Standby</span>
              </div>
              <div className="loop-empty loop-empty--good">
                <p className="loop-empty__title">Brain insights on their own schedule</p>
                <p className="loop-empty__body">
                  The Brain summarizes marketplace activity once it has persisted a briefing. <Link className="loop-card__link" href="/app/admin/brain">Open Brain</Link>
                </p>
              </div>
            </div>
          
          <ContextGroup
            title="Event context"
            caption="Where these events connect across Loop."
            links={[
              {
                icon: "grid",
                title: "Marketplace",
                detail: "Open the marketplace these events flow through.",
                href: "/app/admin/marketplace",
              },
              {
                icon: "chart",
                title: "Campaigns",
                detail: "Jump to the campaigns behind these events.",
                href: "/app/admin/marketplace/campaigns",
              },
              {
                icon: "users",
                title: "Buyers",
                detail: "See the buyers connected to this activity.",
                href: "/app/admin/marketplace/buyers",
              },
              {
                icon: "building",
                title: "Vendors",
                detail: "See the vendors connected to this activity.",
                href: "/app/admin/marketplace/vendors",
              },
              {
                icon: "flow",
                title: "Sources",
                detail: "See the sources connected to this activity.",
                href: "/app/admin/marketplace/sources",
              },
              {
                icon: "brain",
                title: "Brain",
                detail: "See how these events inform recommendations.",
                href: "/app/admin/brain",
              },
              {
                icon: "flow",
                title: "My Work",
                detail: "Open Work OS to act on these events.",
                href: "/app/admin/work",
              },
            ]}
          />
        </aside>
        </div>
      </div>
    </div>
  );
}
