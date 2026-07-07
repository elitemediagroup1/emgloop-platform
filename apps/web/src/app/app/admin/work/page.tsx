import { SidebarIcon } from '../../../crm/_brand/SidebarIcon';
import { ActionTile, BriefingItem } from '../_loop-os';
import { requireWorkspace } from '../../../../workspaces/guard';

// Loop OS -- Admin / Work OS "My Next Action" shell (PR #73).
//
// This is the FIRST visible Work OS surface: /app/admin/work. It is a
// presentation-only, read-only shell. It performs NO data access, NO API
// calls, NO DB writes, NO schema work, NO workflow/task engine, and NO Brain
// execution. It renders premium empty states only -- it never fabricates a
// task, a queue, or Charlie's work. Once the Work OS read model (PR #72) is
// wired to a runtime in a later approved PR, these panels will populate from
// the canonical WorkReadModel; today they announce what is coming.
//
// Guarded server-side by the existing IAM matrix (requireWorkspace('ADMIN')),
// exactly like every other Admin surface -- no UI-only hiding.

export default async function WorkOSPage() {
  await requireWorkspace('ADMIN');

  return (
    <>
      <div className="loop-pagehead">
        <div className="loop-eyebrow">Admin Workspace {"\u00b7"} Work OS</div>
        <h1 className="loop-title">My Work</h1>
        <p className="loop-subtitle">
          Your work will appear here once Work OS is connected.
        </p>
      </div>

      {/* Executive summary banner -- sets expectation, no fabricated data. */}
      <section className="loop-banner loop-banner--good" aria-label="Work OS status">
        <span className="loop-banner__glyph"><SidebarIcon name="flow" /></span>
        <div className="loop-banner__text">
          <div className="loop-banner__title">Work OS is not connected yet</div>
          <div className="loop-banner__body">
            When it is, this is where you will always know exactly what to do next --
            no training required. Nothing here is a real task yet.
          </div>
        </div>
      </section>

      <div className="loop-grid">
        <div className="loop-grid__content">

          {/* 1. Next Action -- the single next best action. */}
          <section className="loop-card" aria-label="Next action">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Your Next Action</h2>
              <span className="loop-card__hint">The single best thing to do right now.</span>
            </div>
            <div className="loop-empty">
              <span className="loop-empty__icon"><SidebarIcon name="flow" /></span>
              <h3 className="loop-empty__title">No next action yet</h3>
              <p className="loop-empty__body">
                Once Work OS is connected, this panel shows one clear next action --
                what it is, why it is next, and who receives it after you.
              </p>
            </div>
          </section>

          {/* 2. My Queue */}
          <section className="loop-card" aria-label="My queue">
            <div className="loop-card__head">
              <h2 className="loop-card__title">My Queue</h2>
              <span className="loop-card__hint">Work assigned to you, in priority order.</span>
            </div>
            <div className="loop-empty">
              <span className="loop-empty__icon"><SidebarIcon name="columns" /></span>
              <h3 className="loop-empty__title">Your queue is empty</h3>
              <p className="loop-empty__body">Assigned work will appear here once Work OS is connected.</p>
            </div>
          </section>

          {/* 3. Waiting On Others */}
          <section className="loop-card" aria-label="Waiting on others">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Waiting On Others</h2>
              <span className="loop-card__hint">Work stalled on someone or something else.</span>
            </div>
            <div className="loop-empty">
              <span className="loop-empty__icon"><SidebarIcon name="users" /></span>
              <h3 className="loop-empty__title">Nothing waiting</h3>
              <p className="loop-empty__body">Items you are waiting on will appear here once Work OS is connected.</p>
            </div>
          </section>

          {/* 4. Approvals */}
          <section className="loop-card" aria-label="Approvals">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Approvals</h2>
              <span className="loop-card__hint">Decisions you owe that unblock others.</span>
            </div>
            <div className="loop-empty">
              <span className="loop-empty__icon"><SidebarIcon name="bell" /></span>
              <h3 className="loop-empty__title">No approvals pending</h3>
              <p className="loop-empty__body">Approvals you owe will appear here once Work OS is connected.</p>
            </div>
          </section>

          {/* 5. Blocked Work */}
          <section className="loop-card" aria-label="Blocked work">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Blocked Work</h2>
              <span className="loop-card__hint">What cannot move, and why.</span>
            </div>
            <div className="loop-empty">
              <span className="loop-empty__icon"><SidebarIcon name="activity" /></span>
              <h3 className="loop-empty__title">Nothing blocked</h3>
              <p className="loop-empty__body">Blocked items and their blockers will appear here once Work OS is connected.</p>
            </div>
          </section>

          {/* 6. Recently Completed */}
          <section className="loop-card" aria-label="Recently completed">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Recently Completed</h2>
              <span className="loop-card__hint">What you finished lately.</span>
            </div>
            <div className="loop-empty">
              <span className="loop-empty__icon"><SidebarIcon name="star" /></span>
              <h3 className="loop-empty__title">Nothing completed yet</h3>
              <p className="loop-empty__body">Completed work will appear here once Work OS is connected.</p>
            </div>
          </section>

        </div>

        {/* Right rail */}
        <aside className="loop-rail" aria-label="Work OS rail">

          {/* Brain placeholder */}
          <section className="loop-card loop-brief">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Brain</h2>
              <span className="loop-badge loop-badge--idle">Standby</span>
            </div>
            <div className="loop-brief__list">
              <BriefingItem icon="brain" title="Prioritization" />
              <BriefingItem icon="star" title="What to do next" />
            </div>
            <p className="loop-card__hint">
              The Brain will later rank your work. It does not run on this page.
            </p>
          </section>

          {/* Shortcuts: Marketplace + Integrations */}
          <section className="loop-card loop-actions">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Shortcuts</h2>
            </div>
            <div className="loop-launchers">
              <ActionTile icon="star" title="Marketplace" desc="Review performance" href="/app/admin/marketplace" />
              <ActionTile icon="plug" title="Integrations" desc="Manage connections" href="/app/admin/integrations" />
            </div>
          </section>

          {/* Recent Activity placeholder */}
          <section className="loop-card loop-feed">
            <div className="loop-card__head">
              <h2 className="loop-card__title">Recent Activity</h2>
            </div>
            <div className="loop-empty">
              <span className="loop-empty__icon"><SidebarIcon name="activity" /></span>
              <h3 className="loop-empty__title">No activity yet</h3>
              <p className="loop-empty__body">Work changes will appear here once Work OS is connected.</p>
            </div>
          </section>

        </aside>
      </div>
    </>
  );
}
