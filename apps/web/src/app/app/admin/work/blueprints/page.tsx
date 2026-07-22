// Work Types — reusable checklists that Loop guides step by step. ("Blueprint"
// is the internal name; users only ever see "Work Type".)

import Link from 'next/link';

import { requireWorkActor, workRepo } from '../work-data';

export const dynamic = 'force-dynamic';

export default async function WorkTypesPage() {
  const actor = await requireWorkActor();
  const blueprints = await workRepo().listBlueprints(actor.organizationId);

  return (
    <div className="loop-grid">
      <div className="loop-grid__content">
        <div className="loop-pagehead">
          <div className="loop-eyebrow">
            <Link href="/app/admin/work">Work OS</Link> / work types
          </div>
          <h1 className="loop-title">Work Types</h1>
          <p className="loop-subtitle">
            A work type is a reusable set of steps. Start work from one and Loop guides it to completion.
          </p>
        </div>

        <div className="loop-card loop-actions">
          <div className="loop-launchers">
            <Link className="loop-badge" href="/app/admin/work/blueprints/new">
              + New work type
            </Link>
          </div>
        </div>

        {blueprints.length === 0 ? (
          <div className="loop-card">
            <div className="loop-empty">
              <div className="loop-empty__title">No work types yet</div>
              <div className="loop-empty__body">
                Create your first work type, e.g. &ldquo;New Buyer Onboarding&rdquo;.
              </div>
            </div>
          </div>
        ) : (
          <div className="loop-card">
            <ul className="loop-brief__list">
              {blueprints.map((b) => (
                <li key={b.id}>
                  <div className="loop-banner__title">{b.name}</div>
                  {b.description ? (
                    <div className="loop-banner__body">{b.description}</div>
                  ) : null}
                  <div className="loop-card__hint">
                    {b.stages.length} step{b.stages.length === 1 ? '' : 's'}:{' '}
                    {b.stages.map((s) => s.name).join(' → ') || 'none yet'}
                  </div>
                  <Link className="loop-card__hint" href="/app/admin/work/new">
                    Start work from this →
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
