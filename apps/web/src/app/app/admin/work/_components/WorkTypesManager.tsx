// WorkTypesManager — the Work Types administration surface, rendered at the
// bottom of the Work OS page (it no longer has its own route or sidebar tab).
// Work Types ARE Blueprints; this speaks only business language. Read-only for
// settings:view; the edit controls render only when canManage (settings:update).

import Link from 'next/link';
import {
  RESPONSIBILITY_LABELS,
  PRIORITY_LABELS,
  WORK_PRIORITIES,
  WORK_TYPE_CATEGORIES,
  responsibilityLabel,
  type WorkPriority,
  type WorkTypeView,
} from '@emgloop/database';
import {
  createWorkTypeAction,
  updateWorkTypeAction,
  setWorkTypeActiveAction,
  reorderWorkTypeAction,
  installStarterWorkTypesAction,
} from './work-types-actions';

export default function WorkTypesManager({
  types,
  canManage,
}: {
  types: WorkTypeView[];
  canManage: boolean;
}) {
  const activeCount = types.filter((t) => t.active).length;

  return (
    <section className="adm wt-manager" aria-label="Work Types">
      <div className="wt-manager__head">
        <h2 className="wt-manager__title">Work Types</h2>
        <p className="wt-manager__sub">
          {types.length} type{types.length === 1 ? '' : 's'} · {activeCount} active. These are what the team starts work from.
        </p>
      </div>

      {canManage && types.length === 0 ? (
        <section className="adm-card">
          <h3 className="adm-card__title">Get started</h3>
          <p className="adm-empty">Install the approved starter set of work types, then rename, recategorise, or deactivate any of them.</p>
          <form action={installStarterWorkTypesAction}>
            <button className="adm-btn adm-btn--primary" type="submit">Install starter work types</button>
          </form>
        </section>
      ) : null}

      {canManage ? (
        <section className="adm-card">
          <h3 className="adm-card__title">Add a work type</h3>
          <form action={createWorkTypeAction} className="adm-inviteform">
            <label className="adm-field">
              <span className="adm-field__label">Name</span>
              <input className="adm-input" name="name" placeholder="e.g. Buyer Setup" required />
            </label>
            <label className="adm-field">
              <span className="adm-field__label">Category</span>
              <select className="adm-input" name="category" defaultValue="General">
                {WORK_TYPE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="adm-field">
              <span className="adm-field__label">Responsibility</span>
              <select className="adm-input" name="responsibility" defaultValue="GENERAL">
                {Object.entries(RESPONSIBILITY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="adm-field">
              <span className="adm-field__label">Default priority</span>
              <select className="adm-input" name="defaultPriority" defaultValue="normal">
                {WORK_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p as WorkPriority]}</option>)}
              </select>
            </label>
            <button className="adm-btn adm-btn--primary" type="submit">Add</button>
          </form>
        </section>
      ) : null}

      <section className="adm-card">
        <h3 className="adm-card__title">All work types</h3>
        {types.length === 0 ? (
          <p className="adm-empty">No work types yet.</p>
        ) : (
          <div className="adm-tablewrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Name</th><th>Category</th><th>Responsibility</th><th>Default priority</th><th>Status</th>
                  {canManage ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {types.map((t, i) => (
                  <tr key={t.id}>
                    <td>
                      {canManage ? (
                        <form action={updateWorkTypeAction} className="adm-inline">
                          <input type="hidden" name="id" value={t.id} />
                          <input className="adm-input adm-input--sm" name="name" defaultValue={t.name} />
                          <select className="adm-input adm-input--sm" name="category" defaultValue={t.category}>
                            {WORK_TYPE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                          <select className="adm-input adm-input--sm" name="responsibility" defaultValue={t.responsibility ?? 'GENERAL'}>
                            {Object.entries(RESPONSIBILITY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                          </select>
                          <select className="adm-input adm-input--sm" name="defaultPriority" defaultValue={t.defaultPriority}>
                            {WORK_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p as WorkPriority]}</option>)}
                          </select>
                          <button className="adm-btn" type="submit">Save</button>
                        </form>
                      ) : t.name}
                    </td>
                    <td className="adm-faint">{t.category}</td>
                    <td className="adm-faint">{responsibilityLabel(t.responsibility)}</td>
                    <td className="adm-faint">{PRIORITY_LABELS[t.defaultPriority as WorkPriority] ?? t.defaultPriority}</td>
                    <td>
                      <span className={'adm-badge adm-badge--' + (t.active ? 'ok' : 'off')}>{t.active ? 'Active' : 'Inactive'}</span>
                    </td>
                    {canManage ? (
                      <td>
                        <div className="adm-inline">
                          <Link href={`?fields=${t.id}`} className="adm-btn">
                            Fields{t.fields.length ? ` (${t.fields.length})` : ''}
                          </Link>
                          <form action={reorderWorkTypeAction}>
                            <input type="hidden" name="id" value={t.id} />
                            <input type="hidden" name="direction" value="up" />
                            <button className="adm-btn" type="submit" disabled={i === 0} aria-label="Move up">↑</button>
                          </form>
                          <form action={reorderWorkTypeAction}>
                            <input type="hidden" name="id" value={t.id} />
                            <input type="hidden" name="direction" value="down" />
                            <button className="adm-btn" type="submit" disabled={i === types.length - 1} aria-label="Move down">↓</button>
                          </form>
                          <form action={setWorkTypeActiveAction}>
                            <input type="hidden" name="id" value={t.id} />
                            <input type="hidden" name="active" value={t.active ? 'false' : 'true'} />
                            <button className={'adm-btn' + (t.active ? ' adm-btn--danger' : '')} type="submit">
                              {t.active ? 'Deactivate' : 'Activate'}
                            </button>
                          </form>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
