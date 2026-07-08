// PR #75 — Work OS Blueprint Runtime v1
// Create a real WorkInstance from a Blueprint.

import Link from 'next/link';

import { requireWorkActor, workRepo, listAssignableUsers } from '../work-data';
import { createWorkFromBlueprintAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NewWorkPage() {
  const actor = await requireWorkActor();
  const [blueprints, users] = await Promise.all([
    workRepo().listBlueprints(actor.organizationId),
    listAssignableUsers(actor.organizationId),
  ]);

  return (
    <div className="loop-grid">
      <div className="loop-grid__content">
        <div className="loop-pagehead">
          <div className="loop-eyebrow">Work OS</div>
          <h1 className="loop-title">New work instance</h1>
          <p className="loop-subtitle">
            Pick a Blueprint to run. The first stage is created ready and its owner
            is notified that their next action is ready.
          </p>
        </div>

        {blueprints.length === 0 ? (
          <div className="loop-card">
            <div className="loop-empty">
              <div className="loop-empty__title">No blueprints yet</div>
              <div className="loop-empty__body">
                Create a Blueprint first, then run work from it.
              </div>
              <Link className="loop-badge" href="/app/admin/work/blueprints/new">
                + New blueprint
              </Link>
            </div>
          </div>
        ) : (
          <div className="loop-card">
            <form action={createWorkFromBlueprintAction} className="loop-brief__list">
              <label>
                <div className="loop-card__hint">Title</div>
                <input name="title" required placeholder="New Buyer — ABC Roofing" />
              </label>

              <label>
                <div className="loop-card__hint">Description</div>
                <textarea name="description" rows={3} />
              </label>

              <label>
                <div className="loop-card__hint">Blueprint</div>
                <select name="blueprintId" required>
                  <option value="">Choose a blueprint…</option>
                  {blueprints.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.stages.length} stages)
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <div className="loop-card__hint">
                  First owner (used only if the first stage has no default owner)
                </div>
                <select name="firstOwnerUserId">
                  <option value="">Leave to blueprint default / unassigned</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name || u.email}
                    </option>
                  ))}
                </select>
              </label>

              <div className="loop-launchers">
                <button className="loop-badge" type="submit">
                  Create work
                </button>
                <Link className="loop-card__hint" href="/app/admin/work">
                  Cancel
                </Link>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
