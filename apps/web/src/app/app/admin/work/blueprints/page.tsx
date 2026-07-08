// PR #75 — Work OS Blueprint Runtime v1
// List Blueprints (reusable process templates) with a link to create new ones.

import Link from 'next/link';

import { requireWorkActor, workRepo } from '../work-data';

export const dynamic = 'force-dynamic';

export default async function BlueprintsPage() {
  const actor = await requireWorkActor();
  const blueprints = await workRepo().listBlueprints(actor.organizationId);

  return (
    <div className="loop-grid">
      <div className="loop-grid__content">
        <div className="loop-pagehead">
          <div className="loop-eyebrow">
            <Link href="/app/admin/work">Work OS</Link> / blueprints
          </div>
          <h1 className="loop-title">Blueprints</h1>
          <p className="loop-subtitle">
            A Blueprint is a reusable process template. Run one to create a real
            Work Instance that moves stage by stage.
          </p>
        </div>

        <div className="loop-card loop-actions">
          <div className="loop-launchers">
            <Link className="loop-badge" href="/app/admin/work/blueprints/new">
              + New blueprint
            </Link>
          </div>
        </div>

        {blueprints.length === 0 ? (
          <div className="loop-card">
            <div className="loop-empty">
              <div className="loop-empty__title">No blueprints yet</div>
              <div className="loop-empty__body">
                Create your first blueprint, e.g. &ldquo;New Buyer Onboarding&rdquo;.
              </div>
            </div>
          </div>
        ) : (
          <div className="loop-card">
            <ul className="loop-brief__list">
              {blueprints.map((b) => (
                <li key={b.id}>
                  <div className="loop-banner__title">
                    {b.name}{' '}
                    <span className="loop-badge loop-badge--idle">{b.status}</span>
                  </div>
                  {b.description ? (
                    <div className="loop-banner__body">{b.description}</div>
                  ) : null}
                  <div className="loop-card__hint">
                    {b.stages.length} stage{b.stages.length === 1 ? '' : 's'}:{' '}
                    {b.stages.map((s) => s.name).join(' → ') || 'none yet'}
                  </div>
                  <Link className="loop-card__hint" href="/app/admin/work/new">
                    Run this blueprint →
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
