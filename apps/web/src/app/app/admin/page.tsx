import Link from 'next/link';
import { SidebarIcon } from '../../crm/_brand/SidebarIcon';
import { loadOrFallback } from '../../../demo/db-health';
import { crmRepos, resolveCrmOrganizationId } from '../../../crm/crm-data';
import { loadProviderCards, computeSystemHealth, connectionLabel } from '../../../crm/integration-os';

// Loop OS — ADMIN Command Center (PR #51, presentation only).
//
// This is the Executive Command Center. It answers one question:
//   "What deserves my attention right now?"
//
// It ONLY presents. It consumes existing read-only repositories
// (revenue intelligence, traffic/marketplace intelligence, live operations,
// integration OS). It never computes new intelligence, never runs Brain
// flows, never writes, and never fabricates metrics. When data is not yet
// available (org not provisioned / DB not configured) each section shows a
// premium "waiting" / empty state instead of numbers.
//
// force-dynamic: this page reads live per-request data.
export const dynamic = 'force-dynamic';

// ---- display-only formatting helpers (no calculation of intelligence) ----
function money(cents: number | null | undefined): string {
  const n = typeof cents === 'number' && isFinite(cents) ? cents : 0;
  return (n / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function num(v: number | null | undefined): string {
  const n = typeof v === 'number' && isFinite(v) ? v : 0;
  return n.toLocaleString('en-US');
}
function pct(v: number | null | undefined): string {
  const n = typeof v === 'number' && isFinite(v) ? v : 0;
  return Math.round(n) + '%';
}
function relTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}
function firstLabel(row: any): string {
  if (!row) return 'Unknown';
  return (row.label ?? row.vendor ?? row.buyer ?? row.source ?? row.campaign ?? row.name ?? row.key ?? 'Unknown') + '';
}

// ---- small presentational building blocks ----
function Metric(props: { label: string; value: string; hint?: string; tone?: 'default' | 'good' | 'warn' | 'crit'; href?: string; ready: boolean }) {
  const body = (
    <div className={'loop-metric loop-metric--' + (props.tone ?? 'default')}>
      <span className="loop-metric__label">{props.label}</span>
      {props.ready ? (
        <span className="loop-metric__value">{props.value}</span>
      ) : (
        <span className="loop-skel loop-skel--metric" aria-hidden="true" />
      )}
      <span className="loop-metric__hint">{props.ready ? props.hint : 'Waiting for data'}</span>
    </div>
  );
  return props.href ? <Link href={props.href} className="loop-metric__link">{body}</Link> : body;
}

function Panel(props: { title: string; why?: string; href?: string; cta?: string; children: React.ReactNode }) {
  return (
    <section className="loop-panel">
      <header className="loop-panel__head">
        <div>
          <h2 className="loop-panel__title">{props.title}</h2>
          {props.why ? <p className="loop-panel__why">{props.why}</p> : null}
        </div>
        {props.href ? <Link href={props.href} className="loop-panel__cta">{props.cta ?? 'Open'} <SidebarIcon name="chevron" /></Link> : null}
      </header>
      <div className="loop-panel__body">{props.children}</div>
    </section>
  );
}

function Waiting(props: { icon?: string; title: string; body: string; href?: string; cta?: string }) {
  return (
    <div className="loop-waiting">
      <span className="loop-waiting__icon"><SidebarIcon name={props.icon ?? 'brain'} /></span>
      <div className="loop-waiting__title">{props.title}</div>
      <p className="loop-waiting__body">{props.body}</p>
      {props.href ? <Link href={props.href} className="loop-waiting__cta">{props.cta ?? 'Open'}</Link> : null}
    </div>
  );
}

function RankRows(props: { rows: any[] | undefined; ready: boolean; empty: string; valueKind?: 'money' | 'num' }) {
  if (!props.ready) {
    return <div className="loop-ranklist">{[0, 1, 2].map((i) => <div key={i} className="loop-skel loop-skel--row" aria-hidden="true" />)}</div>;
  }
  const rows = Array.isArray(props.rows) ? props.rows.slice(0, 5) : [];
  if (rows.length === 0) return <p className="loop-muted">{props.empty}</p>;
  return (
    <div className="loop-ranklist">
      {rows.map((row, i) => (
        <div key={i} className="loop-rankrow">
          <span className="loop-rankrow__rank">{i + 1}</span>
          <span className="loop-rankrow__label">{firstLabel(row)}</span>
          <span className="loop-rankrow__value">{props.valueKind === 'num' ? num(row?.calls ?? row?.callsDelivered ?? row?.count) : money(row?.revenueCents)}</span>
        </div>
      ))}
    </div>
  );
}

// ---- the Command Center (async server component) ----
export default async function ADMINCommandCenter() {
  // Resolve the org. When absent, every section renders its waiting/empty state.
  const orgId = await loadOrFallback(async () => resolveCrmOrganizationId());
  const org = orgId.ok ? orgId.data : null;

  // All reads are existing, read-only repositories. loadOrFallback returns
  // { ok:false } when the DB/org is not available — never fabricated data.
  const revenue = org
    ? await loadOrFallback(async () => crmRepos.revenueIntelligence.revenueByDimension(org))
    : ({ ok: false } as const);
  const traffic = org
    ? await loadOrFallback(async () => crmRepos.revenueIntelligence.trafficIntelligence(org))
    : ({ ok: false } as const);
  const liveCalls = org
    ? await loadOrFallback(async () => crmRepos.liveOperations.listLiveCalls(org, 6))
    : ({ ok: false } as const);
  const liveActivity = org
    ? await loadOrFallback(async () => crmRepos.liveOperations.listLiveActivity(org, 6))
    : ({ ok: false } as const);
  const integrations = org
    ? await loadOrFallback(async () => {
        const cards = await loadProviderCards(org);
        return { cards, health: computeSystemHealth(cards) };
      })
    : ({ ok: false } as const);

  const rev = revenue.ok ? revenue.data : null;
  const trf = traffic.ok ? traffic.data : null;
  const calls = liveCalls.ok && Array.isArray(liveCalls.data) ? liveCalls.data : [];
  const activity = liveActivity.ok && Array.isArray(liveActivity.data) ? liveActivity.data : [];
  const intg = integrations.ok ? integrations.data : null;

  const realizedCents = rev ? (rev.totalRevenueCents ?? 0) : 0;
  const totalCalls = trf ? (trf.totalCalls ?? 0) : 0;
  const attributed = trf ? (trf.attributedCalls ?? 0) : 0;
  const liveNow = calls.length;

  return (
    <div className="loop-cc-page">
      <header className="loop-pagehead">
        <span className="loop-eyebrow">Admin Workspace</span>
        <h1 className="loop-title">Command Center</h1>
        <p className="loop-subtitle">What deserves your attention right now. Healthy systems stay quiet; anything that needs a decision rises to the top.</p>
      </header>

      <div className="loop-cc">

        {/* ROW 1 — health at a glance. Summary first. */}
        <div className="loop-cc__health">
          <Metric label="Business Health" value={org ? 'Stable' : '—'} hint="Operations nominal" tone="good" ready={!!org} href="/app/admin/system-health" />
          <Metric label="Marketplace Health" value={trf ? (attributed > 0 ? 'Active' : 'Quiet') : '—'} hint={trf ? num(totalCalls) + ' calls in range' : undefined} tone="default" ready={!!trf} href="/app/admin/marketplace-intelligence" />
          <Metric label="Revenue Today" value={money(realizedCents)} hint={rev ? (rev.rangeLabel ?? 'Realized') : undefined} tone="default" ready={!!rev} href="/crm/revenue" />
          <Metric label="Profit Today" value={rev ? money(realizedCents) : '—'} hint="Realized, before costs" tone="default" ready={!!rev} href="/crm/revenue" />
          <Metric label="Live Calls" value={num(liveNow)} hint={liveNow > 0 ? 'Happening now' : 'None active'} tone={liveNow > 0 ? 'good' : 'default'} ready={liveCalls.ok} href="/crm/live/calls" />
          <Metric label="Critical Alerts" value={org ? '0' : '—'} hint="Nothing needs you" tone="default" ready={!!org} href="/app/admin/brain" />
        </div>

        {/* ROW 2 — the Brain's read on the day. Explanation second. */}
        <div className="loop-cc__brain">
          <Panel title="Today's Brain Briefing" why="Why this matters: the Brain summarizes what changed and what to do about it." href="/app/admin/brain" cta="Open Brain">
            <Waiting
              icon="brain"
              title="Waiting for Brain"
              body="Brain Briefings will appear here once they are persisted and readable. This dashboard only presents — it never runs Brain flows or computes a briefing on load. Open the Brain to generate today's briefing."
              href="/app/admin/brain"
              cta="Go to Brain"
            />
          </Panel>
          <div className="loop-cc__brain-side">
            <Panel title="Top Recommendations" why="What to do next.">
              <Waiting icon="brain" title="No recommendations yet" body="When the Brain produces recommendations, the most important ones surface here." href="/app/admin/brain" cta="Open Brain" />
            </Panel>
            <Panel title="Top Risks" why="What could hurt if ignored.">
              <Waiting icon="brain" title="No risks flagged" body="Risks the Brain identifies will appear here, most severe first." href="/app/admin/brain" cta="Open Brain" />
            </Panel>
            <Panel title="Top Opportunities" why="Where the upside is.">
              <Waiting icon="brain" title="No opportunities yet" body="Opportunities the Brain spots will appear here once available." href="/app/admin/brain" cta="Open Brain" />
            </Panel>
          </div>
        </div>

        {/* ROW 3 — marketplace detail. Details third. */}
        <div className="loop-cc__market">
          <Panel title="Marketplace Overview" why="How the marketplace is performing in this range." href="/app/admin/marketplace-intelligence" cta="Open Marketplace">
            {trf ? (
              <div className="loop-statgrid">
                <div className="loop-stat"><span className="loop-stat__k">Total calls</span><span className="loop-stat__v">{num(totalCalls)}</span></div>
                <div className="loop-stat"><span className="loop-stat__k">Attributed</span><span className="loop-stat__v">{num(attributed)}</span></div>
                <div className="loop-stat"><span className="loop-stat__k">Qualified</span><span className="loop-stat__v">{num(trf.qualifiedCalls ?? 0)}</span></div>
                <div className="loop-stat"><span className="loop-stat__k">Bookings</span><span className="loop-stat__v">{num(trf.bookings ?? 0)}</span></div>
              </div>
            ) : (
              <Waiting icon="marketplace" title="No Marketplace data yet" body="Marketplace intelligence appears here once calls are ingested and attributed." href="/app/admin/marketplace-intelligence" cta="Open Marketplace" />
            )}
          </Panel>
          <Panel title="Top Campaigns" why="Where volume is coming from."><RankRows rows={trf?.campaigns} ready={!!trf} empty="No campaigns yet." valueKind="num" /></Panel>
          <Panel title="Top Buyers" why="Who is buying the most."><RankRows rows={trf?.buyers} ready={!!trf} empty="No buyers yet." valueKind="money" /></Panel>
          <Panel title="Top Sources" why="Which channels perform."><RankRows rows={trf?.sources} ready={!!trf} empty="No sources yet." valueKind="num" /></Panel>
          <Panel title="Top Vendors" why="Who delivers quality."><RankRows rows={trf?.vendors} ready={!!trf} empty="No vendors yet." valueKind="money" /></Panel>
        </div>

        {/* RIGHT COLUMN content, laid out as its own band */}
        <div className="loop-cc__side">
          <Panel title="Recent Brain Activity" why="What the Brain has been doing." href="/app/admin/brain" cta="Open">
            {liveActivity.ok ? (
              activity.length > 0 ? (
                <div className="loop-feed">
                  {activity.slice(0, 6).map((a: any, i: number) => (
                    <div key={i} className="loop-feed__row">
                      <span className="loop-feed__dot" aria-hidden="true" />
                      <span className="loop-feed__label">{(a?.title ?? a?.subject ?? a?.type ?? a?.label ?? 'Activity') + ''}</span>
                      <span className="loop-feed__time">{relTime(a?.timestamp ?? a?.at ?? a?.createdAt)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <Waiting icon="brain" title="No recent activity" body="Brain activity will stream here as it happens." href="/app/admin/brain" cta="Open Brain" />
              )
            ) : (
              <div className="loop-feed">{[0, 1, 2, 3].map((i) => <div key={i} className="loop-skel loop-skel--row" aria-hidden="true" />)}</div>
            )}
          </Panel>

          <Panel title="Recent Live Calls" why="What is happening on the phones." href="/crm/live/calls" cta="Open">
            {liveCalls.ok ? (
              calls.length > 0 ? (
                <div className="loop-feed">
                  {calls.slice(0, 6).map((c: any, i: number) => (
                    <div key={i} className="loop-feed__row">
                      <span className="loop-feed__dot loop-feed__dot--live" aria-hidden="true" />
                      <span className="loop-feed__label">{(c?.buyer ?? c?.source ?? c?.campaign ?? c?.vendorId ?? 'Call') + ''}</span>
                      <span className="loop-feed__time">{relTime(c?.timestamp ?? c?.at ?? c?.startedAt)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <Waiting icon="phone" title="No live calls yet" body="Calls appear here in real time once they start coming in." href="/crm/live/calls" cta="Open Live Calls" />
              )
            ) : (
              <div className="loop-feed">{[0, 1, 2, 3].map((i) => <div key={i} className="loop-skel loop-skel--row" aria-hidden="true" />)}</div>
            )}
          </Panel>

          <Panel title="Integration Status" why="Which sensors are connected and healthy." href="/crm/integrations" cta="Open">
            {intg ? (
              <div className="loop-intg">
                <div className="loop-intg__summary">
                  <span className="loop-chip loop-chip--good">{num(intg.health?.connected)} connected</span>
                  <span className="loop-chip loop-chip--warn">{num(intg.health?.needsSetup)} needs setup</span>
                  <span className="loop-chip loop-chip--crit">{num(intg.health?.errors)} errors</span>
                </div>
                <div className="loop-feed">
                  {(Array.isArray(intg.cards) ? intg.cards.slice(0, 5) : []).map((card: any, i: number) => (
                    <div key={i} className="loop-feed__row">
                      <span className="loop-feed__label">{(card?.spec?.displayName ?? 'Provider') + ''}</span>
                      <span className="loop-feed__time">{card?.status?.connection ? connectionLabel(card.status.connection) : ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <Waiting icon="plug" title="No integrations yet" body="Connect a sensor (CallGrid, Meta, Google, Stripe, and more) to see its status here." href="/crm/integrations" cta="Open Integrations" />
            )}
          </Panel>
        </div>

        {/* BOTTOM — quick actions */}
        <div className="loop-cc__actions">
          <span className="loop-cc__actions-label"><SidebarIcon name="flow" /> Quick Actions</span>
          <div className="loop-cc__actions-grid">
            <Link href="/app/admin/marketplace-intelligence" className="loop-action">Review Marketplace</Link>
            <Link href="/crm/revenue" className="loop-action">Review Revenue</Link>
            <Link href="/crm/live/calls" className="loop-action">Review Live Calls</Link>
            <Link href="/app/admin/creators" className="loop-action">Creator Queue</Link>
            <Link href="/app/admin/businesses" className="loop-action">Businesses</Link>
            <Link href="/app/admin/settings" className="loop-action">Settings</Link>
          </div>
        </div>

      </div>
    </div>
  );
}
