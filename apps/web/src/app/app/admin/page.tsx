import Link from "next/link";
import { SidebarIcon } from "../../crm/_brand/SidebarIcon";
import { loadOrFallback } from "../../../demo/db-health";
import { crmRepos, resolveCrmOrganizationId } from "../../../crm/crm-data";
import { loadProviderCards, computeSystemHealth, connectionLabel } from "../../../crm/integration-os";

export const dynamic = "force-dynamic";

function money(cents: number | null | undefined): string {
  const n = typeof cents === "number" && !Number.isNaN(cents) ? cents : 0;
  const dollars = n / 100;
  return "$" + Math.round(dollars).toLocaleString("en-US");
}

function num(n: number | null | undefined): string {
  const v = typeof n === "number" && !Number.isNaN(n) ? n : 0;
  return v.toLocaleString("en-US");
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function todayLabel(): string {
  try {
    return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.round(hrs / 24) + "d ago";
}

function clockDuration(seconds: number | null | undefined): string {
  const s = typeof seconds === "number" && !Number.isNaN(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
}

function sparkPath(seed: number): string {
  const pts: number[] = [];
  for (let i = 0; i < 16; i++) {
    const wob = Math.sin((i + seed) * 0.9) * 14 + Math.cos((i + seed) * 0.5) * 8;
    pts.push(Math.max(6, Math.min(56, 40 + wob)));
  }
  const step = 120 / (pts.length - 1);
  return pts
    .map((y, i) => (i === 0 ? "M" : "L") + (i * step).toFixed(1) + " " + y.toFixed(1))
    .join(" ");
}

type Tone = "good" | "warn" | "crit" | "idle";

function StatusDot(props: { tone: Tone }) {
  return <span className={"loop-dot loop-dot--" + props.tone} aria-hidden="true" />;
}

function Sparkline(props: { seed: number; tone: Tone }) {
  return (
    <svg className={"loop-spark loop-spark--" + props.tone} viewBox="0 0 120 62" preserveAspectRatio="none" aria-hidden="true">
      <path d={sparkPath(props.seed)} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Module(props: {
  icon: string;
  title: string;
  metric: string;
  unit?: string;
  detail: string;
  tone: Tone;
  href: string;
  seed: number;
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
      <Sparkline seed={props.seed} tone={props.tone} />
    </Link>
  );
}

function Bar(props: { label: string; value: string; pct: number; tone: Tone }) {
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

type Ranked = { key?: string; label?: string; revenueCents?: number; orders?: number };

function RankedList(props: { icon: string; title: string; rows: Ranked[]; metric: "revenue" | "orders" }) {
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
                {props.metric === "revenue" ? money(r.revenueCents) : num(r.orders)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function AttentionRow(props: { icon: string; tone: Tone; title: string; detail: string; href: string }) {
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

function BriefingItem(props: { icon: string; title: string }) {
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

function IntegrationPill(props: { name: string; state: "connected" | "needs" | "error" }) {
  const label = props.state === "connected" ? "Connected" : props.state === "error" ? "Error" : "Needs Setup";
  return (
    <div className={"loop-intg__pill loop-intg__pill--" + props.state}>
      <span className="loop-intg__dot" aria-hidden="true" />
      <span className="loop-intg__name">{props.name}</span>
      <span className="loop-intg__state">{label}</span>
    </div>
  );
}

function ActionTile(props: { icon: string; title: string; desc: string; href: string }) {
  return (
    <Link href={props.href} className="loop-launch">
      <span className="loop-launch__icon"><SidebarIcon name={props.icon} /></span>
      <span className="loop-launch__title">{props.title}</span>
      <span className="loop-launch__desc">{props.desc}</span>
    </Link>
  );
}

export default async function AdminOperatingSystem() {
  const org = await resolveCrmOrganizationId();

  const revenueR = org
    ? await loadOrFallback(async () => crmRepos.revenueIntelligence.revenueByDimension(org))
    : { ok: false as const };
  const trafficR = org
    ? await loadOrFallback(async () => crmRepos.revenueIntelligence.trafficIntelligence(org))
    : { ok: false as const };
  const liveCallsR = org
    ? await loadOrFallback(async () => crmRepos.liveOperations.listLiveCalls(org))
    : { ok: false as const };
  const liveActivityR = org
    ? await loadOrFallback(async () => crmRepos.liveOperations.listLiveActivity(org))
    : { ok: false as const };
  const integrationsR = org
    ? await loadOrFallback(async () => {
        const cards = await loadProviderCards(org);
        return { cards, health: computeSystemHealth(cards) };
      })
    : { ok: false as const };

  const rev = revenueR.ok ? revenueR.data : null;
  const traffic = trafficR.ok ? trafficR.data : null;
  const liveCalls = liveCallsR.ok ? liveCallsR.data : [];
  const liveActivity = liveActivityR.ok ? liveActivityR.data : [];
  const integrations = integrationsR.ok ? integrationsR.data : null;
  const cards = integrations ? integrations.cards : [];
  const health = integrations ? integrations.health : null;

  const now = new Date();
  const dateLabel = todayLabel();

  /* ---- surface (never fabricate) attention items from existing data ---- */
  type Attn = { icon: string; tone: Tone; title: string; detail: string; href: string };
  const attention: Attn[] = [];
  const warnCount = health ? (health.warnings || 0) : 0;
  const needsSetup = health ? (health.needsSetup || 0) : 0;
  const errCount = health ? (health.errors || 0) : 0;
  const unattributed = traffic ? (traffic.unattributedCalls || 0) : 0;
  if (errCount > 0) {
    attention.push({ icon: "plug", tone: "crit", title: errCount + " integration " + (errCount === 1 ? "error" : "errors"), detail: "A provider connection is failing and needs attention.", href: "/app/admin/integrations" });
  }
  if (warnCount > 0) {
    attention.push({ icon: "plug", tone: "warn", title: warnCount + " integration " + (warnCount === 1 ? "warning" : "warnings"), detail: "Some providers need attention to stay healthy.", href: "/app/admin/integrations" });
  }
  if (needsSetup > 0) {
    attention.push({ icon: "cog", tone: "warn", title: needsSetup + " " + (needsSetup === 1 ? "provider needs" : "providers need") + " setup", detail: "Finish connecting to unlock full marketplace visibility.", href: "/app/admin/integrations" });
  }
  if (unattributed > 0) {
    attention.push({ icon: "activity", tone: "warn", title: unattributed + " unattributed " + (unattributed === 1 ? "call" : "calls"), detail: "Calls without a known source are waiting to be attributed.", href: "/app/admin/marketplace" });
  }

  const attnCount = attention.length;
  let bannerTone: Tone = "good";
  let bannerTitle = "Everything operating normally";
  let bannerBody = "No critical issues detected. Business is running smoothly.";
  if (errCount > 0) {
    bannerTone = "crit";
    bannerTitle = "Critical issue detected";
    bannerBody = "A provider connection needs immediate attention.";
  } else if (attnCount > 0) {
    bannerTone = "warn";
    bannerTitle = attnCount + (attnCount === 1 ? " thing needs" : " decisions need") + " your attention";
    bannerBody = "Nothing critical. Review when you have a moment.";
  }

  /* ---- module metrics (display existing values only) ---- */
  const totalCalls = traffic ? (traffic.totalCalls || 0) : 0;
  const attributed = traffic ? (traffic.attributedCalls || 0) : 0;
  const qualified = traffic ? (traffic.qualifiedCalls || 0) : 0;
  const bookings = traffic ? (traffic.bookings || 0) : 0;
  const totalRevenue = rev ? (rev.totalRevenueCents || 0) : 0;
  const realizedRevenue = rev ? (rev.realizedRevenueCents || 0) : 0;
  const totalOrders = rev ? (rev.totalOrders || 0) : 0;
  const liveCount = liveCalls.length;
  const buyerRows = rev ? (rev.byBuyer || []) : [];
  const campaignRows = rev ? (rev.byCampaign || []) : [];
  const sourceRows = rev ? (rev.bySource || []) : [];
  const vendorRows = rev ? (rev.byVendor || []) : [];
  const activeBuyers = buyerRows.length;
  const connectedCount = health ? (health.connected || 0) : 0;
  const overallPercent = health ? (health.overallPercent || 0) : 0;

  const marketplaceTone: Tone = totalCalls > 0 ? "good" : "idle";
  const revenueTone: Tone = realizedRevenue > 0 ? "good" : "idle";
  const opsTone: Tone = liveCount > 0 ? "good" : "idle";
  const bizTone: Tone = activeBuyers > 0 ? "good" : "idle";
  const creatorTone: Tone = "good";
  const brainTone: Tone = "idle";

  /* pure-css marketplace visual proportions (relative to totalCalls) */
  const denom = Math.max(1, totalCalls);
  const attributedPct = Math.round((attributed / denom) * 100);
  const qualifiedPct = Math.round((qualified / denom) * 100);
  const bookingsPct = Math.round((bookings / denom) * 100);

  /* integration pills from provider cards (display existing status only) */
  type Pill = { name: string; state: "connected" | "needs" | "error" };
  const pills: Pill[] = (cards || []).map((card: any) => {
    const name = (card && card.spec && (card.spec.displayName || card.spec.name)) || "Provider";
    const conn = card && card.status ? card.status.connection : undefined;
    const label = String(connectionLabel(conn) || "").toLowerCase();
    let state: "connected" | "needs" | "error" = "needs";
    if (label.indexOf("error") >= 0 || label.indexOf("fail") >= 0) state = "error";
    else if (label.indexOf("connect") >= 0 && label.indexOf("not") < 0) state = "connected";
    return { name, state };
  });
  const connectedPills = pills.filter((p) => p.state === "connected");
  const needsPills = pills.filter((p) => p.state === "needs");
  const errorPills = pills.filter((p) => p.state === "error");
  const orderedPills = connectedPills.concat(errorPills, needsPills).slice(0, 6);

  return (
    <div className="loop-os loop-os--v3 loop-os--v4">
      <div className="loop-os__main">
        {/* hero */}
        <header className="loop-hero">
          <div className="loop-hero__lead">
            <h1 className="loop-hero__title">{greeting()}, Matt.</h1>
            <p className="loop-hero__sub">Here{"\u2019"}s what{"\u2019"}s happening across your business.</p>
          </div>
          <div className="loop-hero__chip">
            <SidebarIcon name="calendar" />
            <span className="loop-hero__chiptoday">Today</span>
            <span className="loop-hero__chipdate">{dateLabel}</span>
          </div>
        </header>

        {/* executive status banner */}
        <section className={"loop-banner loop-banner--" + bannerTone} aria-live="polite">
          <span className="loop-banner__glyph"><SidebarIcon name={bannerTone === "good" ? "activity" : bannerTone === "crit" ? "bell" : "bell"} /></span>
          <div className="loop-banner__text">
            <div className="loop-banner__title">{bannerTitle}</div>
            <div className="loop-banner__body">{bannerBody}</div>
          </div>
          {attnCount > 0 ? (
            <a href="#needs-attention" className="loop-banner__cta">View All ({attnCount})</a>
          ) : (
            <span className="loop-banner__ok">All clear</span>
          )}
        </section>

        {/* operating modules */}
        <section className="loop-modgrid" aria-label="Operating modules">
          <Module icon="star" title="Marketplace" metric={num(totalCalls)} unit="Calls" detail={num(attributed) + " attributed \u00b7 " + num(bookings) + " booked"} tone={marketplaceTone} href="/app/admin/marketplace" seed={1} />
          <Module icon="revenue" title="Revenue" metric={money(realizedRevenue)} detail={money(realizedRevenue) + " realized \u00b7 " + num(totalOrders) + " orders"} tone={revenueTone} href="/app/admin/revenue" seed={3} />
          <Module icon="activity" title="Operations" metric={num(liveCount)} unit="Live Calls" detail="In progress right now" tone={opsTone} href="/app/admin/operations" seed={5} />
          <Module icon="building" title="Businesses" metric={num(activeBuyers)} unit="Active Buyers" detail="In your marketplace" tone={bizTone} href="/app/admin/businesses" seed={7} />
          <Module icon="users" title="Creator Network" metric={"\u2014"} detail="No creator metrics available yet" tone="idle" href="/app/admin/creators" seed={9} />
          <Module icon="brain" title="Brain" metric="Standby" detail="Waiting for today's briefing" tone={brainTone} href="/app/admin/brain" seed={11} />
        </section>

        {/* two-column grid: content + persistent right rail */}
        <div className="loop-grid">
          <div className="loop-grid__content">
            {/* needs attention */}
            <section id="needs-attention" className="loop-card loop-attn">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Needs Attention{attnCount > 0 ? <span className="loop-count">{attnCount}</span> : null}</h2>
                <span className="loop-card__hint">What deserves your focus right now.</span>
              </div>
              {attnCount === 0 ? (
                <div className="loop-empty loop-empty--good">
                  <span className="loop-empty__glyph">{"\u2713"}</span>
                  <div className="loop-empty__title">Everything looks healthy.</div>
                  <div className="loop-empty__body">No action is required right now. Healthy systems stay quiet.</div>
                </div>
              ) : (
                <div className="loop-attn__list">
                  {attention.map((a, i) => (
                    <AttentionRow key={a.title + i} icon={a.icon} tone={a.tone} title={a.title} detail={a.detail} href={a.href} />
                  ))}
                </div>
              )}
            </section>

            {/* marketplace overview */}
            <section className="loop-card loop-market">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Marketplace Overview</h2>
                <Link href="/app/admin/marketplace" className="loop-card__link">Open Marketplace <span aria-hidden="true">{"\u2192"}</span></Link>
              </div>
              <div className="loop-market__body">
                <div className="loop-market__bars">
                  <Bar label="Attributed Calls" value={num(attributed)} pct={attributedPct} tone="good" />
                  <Bar label="Qualified Calls" value={num(qualified)} pct={qualifiedPct} tone="good" />
                  <Bar label="Bookings" value={num(bookings)} pct={bookingsPct} tone="warn" />
                </div>
                <div className="loop-market__ranks">
                  <RankedList icon="star" title="Top Campaigns" rows={campaignRows} metric="orders" />
                  <RankedList icon="building" title="Top Buyers" rows={buyerRows} metric="orders" />
                  <RankedList icon="flow" title="Top Sources" rows={sourceRows} metric="orders" />
                  <RankedList icon="plug" title="Top Vendors" rows={vendorRows} metric="orders" />
                </div>
              </div>
            </section>

            {/* quick actions */}
            <section className="loop-card loop-actions">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Quick Actions</h2>
              </div>
              <div className="loop-launchers">
                <ActionTile icon="star" title="Marketplace" desc="Review performance" href="/app/admin/marketplace" />
                <ActionTile icon="revenue" title="Revenue" desc="Track performance" href="/app/admin/revenue" />
                <ActionTile icon="users" title="CRM" desc="Manage relationships" href="/app/admin/crm" />
                <ActionTile icon="building" title="Businesses" desc="Manage buyers" href="/app/admin/businesses" />
                <ActionTile icon="team" title="Creators" desc="Review content" href="/app/admin/creators" />
                <ActionTile icon="flow" title="Experiments" desc="View results" href="/app/admin/experiments" />
                <ActionTile icon="plug" title="Integrations" desc="Manage connections" href="/app/admin/integrations" />
                <ActionTile icon="cog" title="Settings" desc="System settings" href="/app/admin/settings" />
              </div>
            </section>
          </div>

          {/* persistent right rail */}
          <aside className="loop-rail" aria-label="Executive rail">
            {/* executive briefing */}
            <section className="loop-card loop-brief">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Executive Briefing</h2>
                <span className="loop-badge loop-badge--idle">Standby</span>
              </div>
              <div className="loop-brief__list">
                <BriefingItem icon="chart" title="Today's Summary" />
                <BriefingItem icon="star" title="Top Recommendation" />
                <BriefingItem icon="bell" title="Primary Risk" />
                <BriefingItem icon="revenue" title="Largest Opportunity" />
              </div>
              <Link href="/app/admin/brain" className="loop-brief__open">Open Brain <span aria-hidden="true">{"\u2192"}</span></Link>
              <p className="loop-brief__note">The Brain computes intelligence on its own schedule. Briefings appear here once persisted.</p>
            </section>

            {/* recent activity */}
            <section className="loop-card loop-feed">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Recent Activity</h2>
                <Link href="/app/admin/operations" className="loop-card__link">View all</Link>
              </div>
              {liveActivity.length === 0 ? (
                <div className="loop-quiet">No recent activity.</div>
              ) : (
                <ul className="loop-feed__list">
                  {liveActivity.slice(0, 6).map((a: any, i: number) => (
                    <li key={(a.id || "") + i} className="loop-feed__item">
                      <span className="loop-feed__dot" aria-hidden="true" />
                      <span className="loop-feed__label">{a.label || a.kind || "Event"}</span>
                      <span className="loop-feed__time">{relTime(a.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* live calls */}
            <section className="loop-card loop-feed">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Live Calls{liveCount > 0 ? <span className="loop-count">{liveCount}</span> : null}</h2>
                <Link href="/app/admin/operations" className="loop-card__link">View all</Link>
              </div>
              {liveCalls.length === 0 ? (
                <div className="loop-quiet">No live calls right now.</div>
              ) : (
                <ul className="loop-feed__list">
                  {liveCalls.slice(0, 6).map((c: any, i: number) => (
                    <li key={(c.id || "") + i} className="loop-feed__item">
                      <span className="loop-feed__phone" aria-hidden="true"><SidebarIcon name="chat" /></span>
                      <span className="loop-feed__label">{c.caller || c.customerName || "Caller"}</span>
                      <span className="loop-feed__time">{clockDuration(c.durationSeconds)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* integration status */}
            <section className="loop-card loop-intg">
              <div className="loop-card__head">
                <h2 className="loop-card__title">Integration Status</h2>
                <Link href="/app/admin/integrations" className="loop-card__link">View all</Link>
              </div>
              <div className="loop-intg__summary">
                <span className="loop-intg__stat loop-intg__stat--connected">{num(connectedPills.length)} Connected</span>
                <span className="loop-intg__stat loop-intg__stat--needs">{num(needsPills.length)} Needs Setup</span>
                <span className="loop-intg__stat loop-intg__stat--error">{num(errorPills.length)} Errors</span>
              </div>
              {orderedPills.length === 0 ? (
                <div className="loop-quiet">No providers configured.</div>
              ) : (
                <div className="loop-intg__grid">
                  {orderedPills.map((p, i) => (
                    <IntegrationPill key={p.name + i} name={p.name} state={p.state} />
                  ))}
                </div>
              )}
            </section>
          </aside>
        </div>

        {/* footer status */}
        <footer className="loop-foot">
          <span className="loop-foot__dot" aria-hidden="true" />
          <span className="loop-foot__label">All Systems Online</span>
          {health ? <span className="loop-foot__meta">{num(overallPercent)}% integration health</span> : null}
        </footer>
      </div>
    </div>
  );
}
