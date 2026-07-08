// PR #75 — Work OS Blueprint Runtime v1
// Create a Blueprint. Stages are entered as one name per line and become
// BlueprintStages in order. Example seed: "New Buyer Onboarding".

import Link from 'next/link';

import { requireWorkActor } from '../../work-data';
import { createBlueprintAction } from '../../actions';

export const dynamic = 'force-dynamic';

export default async function NewBlueprintPage() {
  // Ensures the page is admin-gated and scoped before rendering the form.
  await requireWorkActor();

  return (
    <div className="loop-grid">
      <div className="loop-grid__content">
        <div className="loop-pagehead">
          <div className="loop-eyebrow">
            <Link href="/app/admin/work/blueprints">Blueprints</Link> / new
          </div>
          <h1 className="loop-title">New blueprint</h1>
          <p className="loop-subtitle">
            Name the process and list its stages, one per line, in order.
          </p>
        </div>

        <div className="loop-card">
          <form action={createBlueprintAction} className="loop-brief__list">
            <label>
              <div className="loop-card__hint">Name</div>
              <input name="name" required placeholder="New Buyer Onboarding" />
            </label>

            <label>
              <div className="loop-card__hint">Description</div>
              <textarea name="description" rows={2} />
            </label>

            <label>
              <div className="loop-card__hint">Stages (one per line, in order)</div>
              <textarea
                name="stages"
                rows={6}
                defaultValue={`Review Agreement
Create Buyer Record
Campaign Setup
QA Campaign
Go Live`}
              />
            </label>

            <div className="loop-launchers">
              <button className="loop-badge" type="submit">
                Create blueprint
              </button>
              <Link className="loop-card__hint" href="/app/admin/work/blueprints">
                Cancel
              </Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
