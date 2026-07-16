import Link from "next/link";
import { SidebarIcon } from "../../../crm/_brand/SidebarIcon";
import { loadOrFallback } from "../../../../demo/db-health";
import { crmRepos, requireCrmContext } from "../../../../crm/crm-data";
import { loadProviderCards, computeSystemHealth, connectionLabel } from "../../../../crm/integration-os";
import {
  num,
  todayLabel,
  relTime,
  clockDuration,
  IntegrationStatusPanel,
  ContextGroup,
} from "../../_loop-os";

export const dynamic = "force-dynamic";

type Pill = { name: string; state: "connected" | "needs" | "error" };

export default async function BrainOperatingSystemPage() {
  const { organizationId: org } = await requireCrmContext();

  const liveCallsR = org
    ? await loadOrFallback(async () => crmRepos.liveOperations.listLiveCalls(org))
    : ({ ok: false } as const);
  const liveActivityR = org
    ? await loadOrFallback(async () => crmRepos.liveOperations.listLiveActivity(org))
    : ({ ok: false } as const);
  const integrationsR = org
    ? await loadOrFallback(async () => loadProviderCards(org))
    : ({ ok: false } as const);

  const liveCalls = liveCallsR.ok ? liveCallsR.data : [];
  const liveActivity = liveActivityR.ok ? liveActivityR.data : [];
  const cards = integrationsR.ok ? integrationsR.data : [];
  const health = computeSystemHealth(cards);

  const pills: Pill[] = cards.map((card: any) => {
    const name = card.spec.displayName;
    const conn = card.status?.connection ?? undefined;
    const label = String(connectionLabel(conn)).toLowerCase();
    let state: Pill["state"] = "needs";
    if (label.indexOf("connect") >= 0 && label.indexOf("not") < 0) state = "connected";
    else if (label.indexOf("error") >= 0 || label.indexOf("fail") >= 0) state = "error";
    return { name, state };
  });
  const connectedPills = pills.filter((p) => p.state === "connected");
  const needsPills = pills.filter((p) => p.state === "needs");
  const errorPills = pills.filter((p) => p.state === "error");
  const orderedPills = connectedPills.concat(errorPills, needsPills).slice(0, 6);

  const observedSignals = liveActivity.length;
  const observedCalls = liveCalls.length;

  return (
    <div className="loop-os loop-os--v3 loop-os--v4 loop-os--v5">
      <main className="loop-os__main">
        <header className="loop-os__brief">
          <div className="loop-os__brief-main">
            <p className="loop-os__brief-lead">The Brain</p>
            <p className="loop-os__brief-body">
              Your operating intelligence layer. The Brain observes the business, weighs
              evidence, and surfaces what deserves a decision &mdash; not a conversation.
            </p>
          </div>
          <div className="loop-os__brief-cta">
            <span className="loop-os__brief-chip loop-os__brief-chiptoday">Read-only</span>
            <span className="loop-os__brief-chip loop-os__brief-chipdate">{todayLabel()}</span>
          </div>
        </header>

        <section className="loop-modgrid">
          <div className="loop-card loop-mod">
            <div className="loop-mod__top">
              <span className="loop-mod__icon"><SidebarIcon name="brain" /></span>
              <span className="loop-mod__name">Brain Status</span>
            </div>
            <div className="loop-mod__metric">
              <span className="loop-mod__value">Standby</span>
            </div>
            <p className="loop-mod__detail">Waiting for today&rsquo;s briefing to be computed.</p>
          </div>
          <div className="loop-card loop-mod">
            <div className="loop-mod__top">
              <span className="loop-mod__icon"><SidebarIcon name="activity" /></span>
              <span className="loop-mod__name">Signals Observed</span>
            </div>
            <div className="loop-mod__metric">
              <span className="loop-mod__value">{num(observedSignals)}</span>
            </div>
            <p className="loop-mod__detail">Live activity events in view right now.</p>
          </div>
          <div className="loop-card loop-mod">
            <div className="loop-mod__top">
              <span className="loop-mod__icon"><SidebarIcon name="chat" /></span>
              <span className="loop-mod__name">Live Calls</span>
            </div>
            <div className="loop-mod__metric">
              <span className="loop-mod__value">{num(observedCalls)}</span>
            </div>
            <p className="loop-mod__detail">Conversations the Brain can attribute.</p>
          </div>
          <div className="loop-card loop-mod">
            <div className="loop-mod__top">
              <span className="loop-mod__icon"><SidebarIcon name="plug" /></span>
              <span className="loop-mod__name">Evidence Sources</span>
            </div>
            <div className="loop-mod__metric">
              <span className="loop-mod__value">{num(connectedPills.length)}</span>
              <span className="loop-mod__unit">connected</span>
            </div>
            <p className="loop-mod__detail">{num(health.needsSetup)} awaiting setup.</p>
          </div>
        </section>

        <div className="loop-grid">
          <div className="loop-grid__content">
            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Executive Brain Summary</span>
                <span className="loop-badge loop-badge--idle">Standby</span>
              </div>
              <div className="loop-empty">
                <span className="loop-empty__icon"><SidebarIcon name="brain" /></span>
                <p className="loop-empty__title">No briefing has been computed yet.</p>
                <p className="loop-empty__body">
                  The Brain publishes a single, immutable briefing on its own schedule. When
                  today&rsquo;s run is persisted, its executive read &mdash; the state of the
                  business, the headline risk, and the largest opportunity &mdash; appears here.
                </p>
                <p className="loop-empty__next">Next: the Brain will summarize once a briefing is available.</p>
              </div>
            </div>

            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Recommendations</span>
                <span className="loop-badge loop-badge--idle">Awaiting Brain</span>
              </div>
              <div className="loop-empty">
                <span className="loop-empty__icon"><SidebarIcon name="star" /></span>
                <p className="loop-empty__title">No recommendations to review.</p>
                <p className="loop-empty__body">
                  Recommendations are derived from the Brain&rsquo;s diagnoses, ranked by
                  severity. Each one will carry the evidence behind it &mdash; never a guess.
                </p>
                <p className="loop-empty__next">Next: recommendations surface after diagnostics run.</p>
              </div>
            </div>

            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Risks</span>
                <span className="loop-badge loop-badge--idle">Awaiting Brain</span>
              </div>
              <div className="loop-empty">
                <span className="loop-empty__icon"><SidebarIcon name="bell" /></span>
                <p className="loop-empty__title">No risks flagged.</p>
                <p className="loop-empty__body">
                  Critical and high-severity findings appear here first, oldest issue leading.
                  Nothing is escalated until the Brain has evidence to support it.
                </p>
                <p className="loop-empty__next">Next: risks are triaged severity-first once observed.</p>
              </div>
            </div>

            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Opportunities</span>
                <span className="loop-badge loop-badge--idle">Awaiting Brain</span>
              </div>
              <div className="loop-empty">
                <span className="loop-empty__icon"><SidebarIcon name="revenue" /></span>
                <p className="loop-empty__title">No opportunities identified.</p>
                <p className="loop-empty__body">
                  Upside the Brain believes is worth pursuing &mdash; underused sources, buyers
                  ready to scale, campaigns worth more budget &mdash; will be listed here.
                </p>
                <p className="loop-empty__next">Next: opportunities appear when the Brain sees room to grow.</p>
              </div>
            </div>

            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Unknowns &amp; Missing Evidence</span>
                <span className="loop-badge loop-badge--idle">Honest</span>
              </div>
              <div className="loop-market__body">
                {orderedPills.length > 0 && needsPills.length > 0 ? (
                  <>
                    <p className="loop-card__hint">
                      The Brain sees fewer signals than it could. These sources are not yet
                      connected, so any read on them is incomplete.
                    </p>
                    <div className="loop-brief">
                      {needsPills.slice(0, 5).map((p) => (
                        <div className="loop-brief__item" key={p.name}>
                          <span className="loop-brief__icon"><SidebarIcon name="plug" /></span>
                          <div className="loop-brief__text">
                            <div className="loop-brief__title">{p.name}</div>
                            <div className="loop-brief__wait">Not connected &mdash; evidence unavailable.</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="loop-empty">
                    <span className="loop-empty__icon"><SidebarIcon name="search" /></span>
                    <p className="loop-empty__title">Nothing flagged as unknown.</p>
                    <p className="loop-empty__body">
                      When the Brain cannot reach a confident conclusion, it says so here
                      instead of guessing &mdash; naming what it would need to know more.
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Recent Brain Activity</span>
              </div>
              <div className="loop-market__body">
                {liveActivity.length > 0 ? (
                  <ul className="loop-feed__list">
                    {liveActivity.slice(0, 6).map((a: any) => (
                      <li className="loop-feed__item" key={a.id}>
                        <span className="loop-feed__dot" />
                        <span className="loop-feed__label">{a.label}</span>
                        <span className="loop-feed__time">{relTime(a.at)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="loop-empty">
                    <span className="loop-empty__icon"><SidebarIcon name="activity" /></span>
                    <p className="loop-empty__title">No Brain activity recorded yet.</p>
                    <p className="loop-empty__body">
                      Every diagnosis the Brain publishes lands here as an immutable record.
                      The feed stays empty until the first activity is persisted.
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Decision Queue</span>
                <span className="loop-badge loop-badge--idle">0 pending</span>
              </div>
              <div className="loop-empty loop-empty--good">
                <span className="loop-empty__icon"><SidebarIcon name="flow" /></span>
                <p className="loop-empty__title">No decisions are waiting on you.</p>
                <p className="loop-empty__body">
                  When the Brain needs a human call &mdash; approve, dismiss, or escalate
                  &mdash; it queues the decision here with the evidence attached. Nothing is
                  acted on automatically.
                </p>
                <p className="loop-empty__next">Next: decisions appear once the Brain has something to recommend.</p>
              </div>
            </div>
          </div>

          <aside className="loop-rail">
            <div className="loop-card">
              <div className="loop-card__head">
                <span className="loop-card__title">Jump to</span>
              </div>
              <div className="loop-brief">
                <Link className="loop-brief__item" href="/app/admin/marketplace">
                  <span className="loop-brief__icon"><SidebarIcon name="grid" /></span>
                  <div className="loop-brief__text">
                    <div className="loop-brief__title">Open Marketplace</div>
                    <div className="loop-brief__wait">Where the Brain&rsquo;s calls become revenue.</div>
                  </div>
                </Link>
                <Link className="loop-brief__item" href="/app/admin/work">
                  <span className="loop-brief__icon"><SidebarIcon name="flow" /></span>
                  <div className="loop-brief__text">
                    <div className="loop-brief__title">Open Work OS</div>
                    <div className="loop-brief__note">See what to do next across Loop.</div>
                  </div>
                </Link>
              </div>
            </div>

            <div className="loop-card loop-intg-panel">
              <IntegrationStatusPanel cards={cards} health={health} title="Integration Status" />
            </div>

            <div className="loop-card loop-feed">
              <div className="loop-card__head">
                <span className="loop-card__title">Recent Activity</span>
              </div>
              {liveActivity.length > 0 ? (
                <ul className="loop-feed__list">
                  {liveActivity.slice(0, 5).map((a: any) => (
                    <li className="loop-feed__item" key={a.id}>
                      <span className="loop-feed__dot" />
                      <span className="loop-feed__label">{a.label}</span>
                      <span className="loop-feed__time">{relTime(a.at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="loop-empty">
                  <p className="loop-empty__title">No activity yet</p>
                  <p className="loop-empty__body">Activity will appear here as it is recorded.</p>
                </div>
              )}
            </div>

            <div className="loop-card loop-feed">
              <div className="loop-card__head">
                <span className="loop-card__title">Live Calls <span className="loop-count">{num(liveCalls.length)}</span></span>
              </div>
              {liveCalls.length > 0 ? (
                <ul className="loop-feed__list">
                  {liveCalls.slice(0, 5).map((c: any) => (
                    <li className="loop-feed__item" key={c.id}>
                      <span className="loop-feed__phone" />
                      <span className="loop-feed__label">{c.customerName || c.caller}</span>
                      <span className="loop-feed__time">{clockDuration(c.durationSeconds)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="loop-empty">
                  <p className="loop-empty__title">No live calls</p>
                  <p className="loop-empty__body">Active calls will appear here.</p>
                </div>
              )}
            </div>
          
          <ContextGroup
            title="Recommendation context"
            caption="Where today's recommendations will connect once the Brain runs."
            links={[]}
            emptyTitle="Waiting for today's briefing"
            emptyBody="When a briefing is persisted, each recommendation will show the campaigns, buyers, and workspaces it affects."
          />
        </aside>
        </div>
      </main>
    </div>
  );
}
