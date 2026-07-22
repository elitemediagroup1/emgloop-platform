import Link from 'next/link';
import { requireWorkActor, workRepo, listAssignableUsers } from '../work-data';
import { createWorkFromBlueprintAction } from '../actions';

// Start Work — a focused, conversational form. Backend unchanged: the fields map
// to the existing action (blueprintId / title / description / firstOwnerUserId);
// only the experience and terminology changed. No Work Instance / Blueprint /
// Stage / owner-caveat wording reaches the screen.

export const dynamic = 'force-dynamic';

export default async function StartWorkPage() {
  const actor = await requireWorkActor();
  const [blueprints, users] = await Promise.all([
    workRepo().listBlueprints(actor.organizationId),
    listAssignableUsers(actor.organizationId),
  ]);

  return (
    <div className="loop-os">
      <div className="sw">
        <div className="sw__head">
          <h1 className="sw__title">Start Work</h1>
          <p className="sw__purpose">Start a piece of work and Loop will guide it through completion.</p>
        </div>

        {blueprints.length === 0 ? (
          <div className="sw__card">
            <p className="sw__empty">You don’t have any work types yet. Create one first, then start work from it.</p>
            <Link href="/app/admin/work/blueprints/new" className="adm-btn adm-btn--primary">Create a work type</Link>
          </div>
        ) : (
          <form action={createWorkFromBlueprintAction} className="sw__form">
            <label className="sw__field">
              <span className="sw__label">What are you trying to accomplish?</span>
              <select name="blueprintId" required className="sw__input" defaultValue="">
                <option value="" disabled>Choose…</option>
                {blueprints.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </label>

            <label className="sw__field">
              <span className="sw__label">Work name</span>
              <input name="title" required placeholder="e.g. Onboard ABC Roofing" className="sw__input" />
            </label>

            <label className="sw__field">
              <span className="sw__label">Notes <span className="sw__opt">Optional</span></span>
              <textarea name="description" rows={3} placeholder="Anything the team should know" className="sw__input sw__textarea" />
            </label>

            <label className="sw__field">
              <span className="sw__label">First person responsible</span>
              <select name="firstOwnerUserId" className="sw__input" defaultValue="">
                <option value="">Decide later</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name || u.email}</option>
                ))}
              </select>
            </label>

            <div className="sw__actions">
              <button type="submit" className="adm-btn adm-btn--primary sw__submit">Start Work</button>
              <Link href="/app/admin/work" className="sw__cancel">Cancel</Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
