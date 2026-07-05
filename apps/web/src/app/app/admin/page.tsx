import Link from "next/link";
import { SidebarIcon } from "../../crm/_brand/SidebarIcon";
import { loadOrFallback } from "../../../demo/db-health";
import { crmRepos, resolveCrmOrganizationId } from "../../../crm/crm-data";
import { loadProviderCards, computeSystemHealth, connectionLabel } from "../../../crm/integration-os";

// EMG Loop - Admin Command Center v2 (Mission Control).
// PRESENTATION ONLY. This page consumes existing read-only repositories and
// renders them. It computes no intelligence: the Brain remains the only
// component that computes. No fabricated metrics, no fake recommendations.
// All "attention" items below are surfaced from data that already exists
// (integration health warnings/errors, missing setup items). Nothing new
// is calculated beyond display formatting.

type Ok<T> = { ok: true; data: T } | { ok: false };

function money(cents: number | null | undefined): string {
  const v = typeof cents === "number" ? cents : 0;
  return (v / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function num(n: number | null | undefined): string {
  return (typeof n === "number" ? n : 0).toLocaleString("en-US");
}

function pct(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

function relTime(at: string | Date | null | undefined): string {
  if (!at) return "";
  const t = typeof at === "string" ? Date.parse(at) : at.getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.round(hrs / 24);
  return days + "d ago";
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function StatusDot({ tone }: { tone: "good" | "warn" | "crit" | "idle" }) {
  return <span className={"loop-dot loop-dot--" + tone} aria-hidden="true" />;
}

function Module(props: {
  href: string;
  icon: string;
  title: string;
  metric: string;
  hint: string;
  tone: "good" | "warn" | "crit" | "idle";
  loading?: boolean;
}) {
  return (
    <Link href={props.href} className="loop-mod">
      <div className="loop-mod__top">
        <span className="loop-mod__icon">
          <SidebarIcon name={props.icon} />
        </span>
        <span className="loop-mod__title">{props.title}</span>
        <StatusDot tone={props.tone} />
      </div>
      {props.loading ? (
        <div className="loop-skel loop-skel--metric" />
      ) : (
        <div className="loop-mod__metric">{props.metric}</div>
      )}
      <div className="loop-mod__hint">{props.hint}</div>
    </Link>
  );
}

function Bar(props: { label: string; value: string; pct: number }) {
  const width = Math.max(2, Math.min(100, props.pct));
  return (
    <div className="loop-bar">
      <div className="loop-bar__head">
        <span className="loop-bar__label">{props.label}</span>
        <span className="loop-bar__value">{props.value}</span>
      </div>
      <div className="loop-bar__track">
        <div className="loop-bar__fill" style={{ width: width + "%" }} />
      </div>
    </div>
  );
}

function RevenueBars({
  rows,
}: {
  rows: Array<{ label: string; revenueCents: number }> | undefined;
}) {
  if (!rows || rows.length === 0) {
    return <p className="loop-muted">No marketplace data yet.</p>;
  }
  const top = rows.slice(0, 5);
  const max = Math.max(1, ...top.map((r) => r.revenueCents || 0));
  return (
    <div className="loop-bars">
      {top.map((r, i) => (
        <Bar
          key={i}
          label={r.label || "-"}
          value={money(r.revenueCents)}
          pct={pct(r.revenueCents || 0, max)}
        />
      ))}
    </div>
  );
}

function ActionTile(props: { href: string; icon: string; label: string }) {
  return (
    <Link href={props.href} className="loop-launch">
      <span className="loop-launch__icon">
        <SidebarIcon name={props.icon} />
      </span>
      <span className="loop-launch__label">{props.label}</span>
    </Link>
  );
}

export default async function AdminCommandCenter() {
  const org = await resolveCrmOrganizationId();

  const revenueR: Ok<any> = org
    ? await loadOrFallback(async () =>
        crmRepos.revenueIntelligence.revenueByDimension(org)
      )
    : { ok: false };
  const trafficR: Ok<any> = org
    ? await loadOrFallback(async () =>
        crmRepos.revenueIntelligence.trafficIntelligence(org)
      )
    : { ok: false };
  const liveCallsR: Ok<any> = org
    ? await loadOrFallback(async () =>
        crmRepos.liveOperations.listLiveCalls(org, 6)
      )
    : { ok: false };
  const liveActivityR: Ok<any> = org
    ? await loadOrFallback(async () =>
        crmRepos.liveOperations.listLiveActivity(org, 6)
      )
    : { ok: false };
  const integrationsR: Ok<any> = org
    ? await loadOrFallback(async () => {
        const cards = await loadProviderCards(org);
        return { cards, health: computeSystemHealth(cards) };
      })
    : { ok: false };

  const rev = revenueR.ok ? revenueR.data : null;
  const traffic = trafficR.ok ? trafficR.data : null;
  const liveCalls = liveCallsR.ok ? liveCallsR.data : null;
  const liveActivity = liveActivityR.ok ? liveActivityR.data : null;
  const integrations = integrationsR.ok ? integrationsR.data : null;
  const health = integrations ? integrations.health : null;
  const cards = integrations ? integrations.cards : [];

  const attention: Array<{ tone: "warn" | "crit"; title: string; detail: string; href: string }> = [];
  if (health) {
    if (typeof health.errors === "number" && health.errors > 0) {
      attention.push({
        tone: "crit",
        title: health.errors + (health.errors === 1 ? " integration error" : " integration errors"),
        detail: "One or more connected providers reported an error.",
        href: "/app/admin/integrations",
      });
    }
    if (typeof health.warnings === "number" && health.warnings > 0) {
      attention.push({
        tone: "warn",
        title: health.warnings + (health.warnings === 1 ? " integration warning" : " integration warnings"),
        detail: "Some providers need attention to stay healthy.",
        href: "/app/admin/integrations",
      });
    }
    if (typeof health.needsSetup === "number" && health.needsSetup > 0) {
      attention.push({
        tone: "warn",
        title: health.needsSetup + " provider" + (health.needsSetup === 1 ? "" : "s") + " need setup",
        detail: "Finish connecting to unlock full marketplace visibility.",
        href: "/app/admin/integrations",
      });
    }
  }
  if (traffic && typeof traffic.unattributedCalls === "number" && traffic.unattributedCalls > 0) {
    attention.push({
      tone: "warn",
      title: num(traffic.unattributedCalls) + " unattributed calls",
      detail: "Calls without a known source are waiting to be attributed.",
      href: "/app/admin/marketplace-intelligence",
    });
  }

  const banner = (() => {
    const hasCrit = attention.some((a) => a.tone === "crit");
    if (hasCrit) {
      return { tone: "crit" as const, title: "Attention needed", body: "Critical issues were detected in your existing data. Review the items below." };
    }
    if (attention.length > 0) {
      return { tone: "warn" as const, title: "A few things to review", body: "Nothing critical. A handful of items could use your attention." };
    }
    return { tone: "good" as const, title: "Operations healthy", body: "No critical issues detected. Business is operating normally." };
  })();

  const revTotal = rev ? rev.totalRevenueCents : null;
  const revRealized = rev ? rev.realizedRevenueCents : null;
  const liveCount = Array.isArray(liveCalls) ? liveCalls.length : 0;

  const modules = [
    {
      href: "/app/admin/marketplace-intelligence",
      icon: "star",
      title: "Marketplace",
      metric: traffic ? num(traffic.totalCalls) + " calls" : "-",
      hint: traffic ? num(traffic.attributedCalls) + " attributed \u00b7 " + num(traffic.bookings) + " booked" : "No marketplace data yet",
      tone: (traffic ? "good" : "idle") as "good" | "idle",
      loading: false,
    },
    {
      href: "/app/admin/revenue",
      icon: "revenue",
      title: "Revenue",
      metric: rev ? money(revTotal) : "-",
      hint: rev ? money(revRealized) + " realized \u00b7 " + num(rev.totalOrders) + " orders" : "No revenue yet",
      tone: (rev ? "good" : "idle") as "good" | "idle",
    },
    {
      href: "/app/admin/live-calls",
      icon: "activity",
      title: "Operations",
      metric: num(liveCount) + " live",
      hint: liveCount > 0 ? "Calls in progress right now" : "No live calls at the moment",
      tone: (liveCount > 0 ? "good" : "idle") as "good" | "idle",
    },
    {
      href: "/app/admin/businesses",
      icon: "building",
      title: "Businesses",
      metric: rev && Array.isArray(rev.byBuyer) ? num(rev.byBuyer.length) : "-",
      hint: "Active buyers in your marketplace",
      tone: (rev && Array.isArray(rev.byBuyer) && rev.byBuyer.length > 0 ? "good" : "idle") as "good" | "idle",
    },
    {
      href: "/app/admin/creators",
      icon: "users",
      title: "Creator Network",
      metric: traffic && Array.isArray(traffic.vendors) ? num(traffic.vendors.length) : "-",
      hint: "Vendors delivering traffic",
      tone: (traffic && Array.isArray(traffic.vendors) && traffic.vendors.length > 0 ? "good" : "idle") as "good" | "idle",
    },
    {
      href: "/app/admin/brain",
      icon: "brain",
      title: "Brain",
      metric: "Standby",
      hint: "Waiting for today's briefing",
      tone: "idle" as "idle",
    },
  ];

  return (
    <div className="loop-cc2">
      <header className="loop-hero">
        <p className="loop-hero__greet">
          {greeting()}
          <span className="loop-hero__name">, Matt</span>
        </p>
        <h1 className="loop-hero__title">Here's what's happening across your business.</h1>
        <div className={"loop-banner loop-banner--" + banner.tone}>
          <span className="loop-banner__dot" aria-hidden="true" />
          <span className="loop-banner__text">
            <strong>{banner.title}</strong>
            <span>{banner.body}</span>
          </span>
        </div>
      </header>

      <section className="loop-modgrid" aria-label="Operating system modules">
        {modules.map((m, i) => (
          <Module key={i} {...m} />
        ))}
      </section>

      <div className="loop-cc2__grid">
        <div className="loop-cc2__main">
          <section className="loop-card">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Needs attention</h2>
              <span className="loop-card__why">What deserves your focus right now.</span>
            </div>
            <div className="loop-card__body">
              {attention.length === 0 ? (
                <div className="loop-quiet">
                  <span className="loop-quiet__icon" aria-hidden="true">{"\u2713"}</span>
                  <div>
                    <p className="loop-quiet__title">Everything looks healthy.</p>
                    <p className="loop-quiet__body">No action is required right now. Healthy systems stay quiet.</p>
                  </div>
                </div>
              ) : (
                <ul className="loop-attn">
                  {attention.map((a, i) => (
                    <li key={i} className="loop-attn__item">
                      <span className={"loop-dot loop-dot--" + a.tone} aria-hidden="true" />
                      <div className="loop-attn__text">
                        <p className="loop-attn__title">{a.title}</p>
                        <p className="loop-attn__detail">{a.detail}</p>
                      </div>
                      <Link href={a.href} className="loop-attn__cta">Review {"\u2192"}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="loop-card">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Marketplace overview</h2>
              <Link href="/app/admin/marketplace-intelligence" className="loop-card__cta">Open {"\u2192"}</Link>
            </div>
            <div className="loop-card__body">
              {traffic ? (
                <div className="loop-dist">
                  <Bar label="Attributed calls" value={num(traffic.attributedCalls)} pct={pct(traffic.attributedCalls, traffic.totalCalls)} />
                  <Bar label="Qualified calls" value={num(traffic.qualifiedCalls)} pct={pct(traffic.qualifiedCalls, traffic.totalCalls)} />
                  <Bar label="Bookings" value={num(traffic.bookings)} pct={pct(traffic.bookings, traffic.totalCalls)} />
                </div>
              ) : (
                <p className="loop-muted">No marketplace data yet.</p>
              )}
            </div>
          </section>

          <div className="loop-cc2__cols">
            <section className="loop-card">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Top campaigns</h2>
              </div>
              <div className="loop-card__body">
                <RevenueBars rows={rev ? rev.byCampaign : undefined} />
              </div>
            </section>
            <section className="loop-card">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Top buyers</h2>
              </div>
              <div className="loop-card__body">
                <RevenueBars rows={rev ? rev.byBuyer : undefined} />
              </div>
            </section>
          </div>

          <div className="loop-cc2__cols">
            <section className="loop-card">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Top sources</h2>
              </div>
              <div className="loop-card__body">
                <RevenueBars rows={rev ? rev.bySource : undefined} />
              </div>
            </section>
            <section className="loop-card">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Top vendors</h2>
              </div>
              <div className="loop-card__body">
                <RevenueBars rows={rev ? rev.byVendor : undefined} />
              </div>
            </section>
          </div>
        </div>

        <aside className="loop-cc2__side">
          <section className="loop-card loop-card--brain">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Executive briefing</h2>
              <Link href="/app/admin/brain" className="loop-card__cta">Open Brain {"\u2192"}</Link>
            </div>
            <div className="loop-card__body">
              <div className="loop-brief">
                {[
                  { k: "Today's summary", v: "Waiting for today's briefing." },
                  { k: "Top recommendation", v: "Waiting for today's briefing." },
                  { k: "Primary risk", v: "Waiting for today's briefing." },
                  { k: "Largest opportunity", v: "Waiting for today's briefing." },
                ].map((b, i) => (
                  <div key={i} className="loop-brief__row">
                    <p className="loop-brief__k">{b.k}</p>
                    <div className="loop-skel loop-skel--line" />
                    <p className="loop-brief__v">{b.v}</p>
                  </div>
                ))}
              </div>
              <p className="loop-brief__note">
                The Brain computes intelligence on its own schedule. Briefings appear here once persisted.
              </p>
            </div>
          </section>

          <section className="loop-card">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Recent activity</h2>
            </div>
            <div className="loop-card__body">
              {Array.isArray(liveActivity) && liveActivity.length > 0 ? (
                <ul className="loop-feed">
                  {liveActivity.map((a: any, i: number) => (
                    <li key={a && a.id ? a.id : i} className="loop-feed__row">
                      <span className="loop-feed__dot" aria-hidden="true" />
                      <span className="loop-feed__label">{a && a.label ? a.label : "Activity"}</span>
                      <span className="loop-feed__time">{a ? relTime(a.at) : ""}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="loop-muted">No recent activity yet.</p>
              )}
            </div>
          </section>

          <section className="loop-card">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Recent live calls</h2>
              <Link href="/app/admin/live-calls" className="loop-card__cta">Open {"\u2192"}</Link>
            </div>
            <div className="loop-card__body">
              {Array.isArray(liveCalls) && liveCalls.length > 0 ? (
                <ul className="loop-feed">
                  {liveCalls.map((c: any, i: number) => (
                    <li key={c && c.id ? c.id : i} className="loop-feed__row">
                      <span className="loop-feed__dot loop-feed__dot--live" aria-hidden="true" />
                      <span className="loop-feed__label">{c && (c.caller || c.customerName) ? (c.caller || c.customerName) : "Live call"}</span>
                      <span className="loop-feed__time">{c ? relTime(c.at) : ""}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="loop-muted">No live calls right now.</p>
              )}
            </div>
          </section>

          <section className="loop-card">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Integration status</h2>
              <Link href="/app/admin/integrations" className="loop-card__cta">Open {"\u2192"}</Link>
            </div>
            <div className="loop-card__body">
              {Array.isArray(cards) && cards.length > 0 ? (
                <ul className="loop-intg">
                  {cards.map((card: any, i: number) => (
                    <li key={i} className="loop-intg__row">
                      <span className="loop-intg__name">
                        {card && card.spec ? card.spec.displayName : "Provider"}
                      </span>
                      <span className="loop-intg__state">
                        {card && card.status ? connectionLabel(card.status.connection) : "Unknown"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="loop-muted">No integrations configured yet.</p>
              )}
            </div>
          </section>
        </aside>
      </div>

      <section className="loop-launchers" aria-label="Quick actions">
        <h2 className="loop-launchers__title">Quick actions</h2>
        <div className="loop-launchers__grid">
          <ActionTile href="/app/admin/marketplace-intelligence" icon="star" label="Review Marketplace" />
          <ActionTile href="/app/admin/revenue" icon="revenue" label="Revenue" />
          <ActionTile href="/app/admin/crm" icon="users" label="CRM" />
          <ActionTile href="/app/admin/businesses" icon="building" label="Businesses" />
          <ActionTile href="/app/admin/creators" icon="team" label="Creators" />
          <ActionTile href="/app/admin/experiments" icon="flow" label="Experiments" />
          <ActionTile href="/app/admin/integrations" icon="plug" label="Integrations" />
          <ActionTile href="/app/admin/settings" icon="cog" label="Settings" />
        </div>
      </section>
    </div>
  );
}
