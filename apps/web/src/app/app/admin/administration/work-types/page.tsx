// Administration › Work Types — manage the reusable work types the whole team
// starts work from. These ARE Blueprints; the page speaks only business language.
// Authorized admins only (settings:view to see, settings:update to change).

import { requirePermission, hasPermission } from '../../../../../auth/guard';
import {
  repositories,
  RESPONSIBILITY_LABELS,
  PRIORITY_LABELS,
  WORK_PRIORITIES,
  WORK_TYPE_CATEGORIES,
  responsibilityLabel,
  type WorkPriority,
} from '@emgloop/database';
import {
  createWorkTypeAction,
  updateWorkTypeAction,
  setWorkTypeActiveAction,
  reorderWorkTypeAction,
  installStarterWorkTypesAction,
} from './actions';
import Link from 'next/link';
import FieldsEditor from './FieldsEditor';

export const dynamic = 'force-dynamic';

export default async function WorkTypesPage({
  searchParams,
}: {
  searchParams?: { notice?: string; error?: string; fields?: string };
}) {
  const session = await requirePermission('settings', 'view');
  const canManage = await hasPermission('settings', 'update');
  const types = await repositories.work.listWorkTypes(session.organizationId, { includeInactive: true });

  const notice = typeof searchParams?.notice === 'string' ? searchParams.notice : null;
  const error = typeof searchParams?.error === 'string' ? searchParams.error : null;
  const activeCount = types.filter((t) => t.active).length;

  // Field-config pane for a single Work Type (managers only).
  const fieldsType = canManage && searchParams?.fields
    ? types.find((t) => t.id === searchParams.fields) ?? null
    : null;
  if (fieldsType) {
    return (
      <div className="adm">
        {error ? <div className="adm-banner adm-banner--error" role="alert">{error}</div> : null}
        {notice ? <div className="adm-banner adm-banner--ok" role="status">{notice}</div> : null}
        <FieldsEditor
          workTypeId={fieldsType.id}
          workTypeName={fieldsType.name}
          initialFields={fieldsType.fields.map((f) => ({
            key: f.key, label: f.label, helper: f.helper, type: f.type,
            required: f.required, options: f.options, active: f.active,
          }))}
        />
      </div>
    );
  }

  return (
    <div className="adm">
      <div className="loop-pagehead">
        <div className="loop-eyebrow">Administration</div>
        <h1 className="loop-title">Work Types</h1>
        <p className="loop-subtitle">
          {types.length} work type{types.length === 1 ? '' : 's'} · {activeCount} active. These are the templates the team starts work from.
        </p>
      </div>

      {error ? <div className="adm-banner adm-banner--error" role="alert">{error}</div> : null}
      {notice ? <div className="adm-banner adm-banner--ok" role="status">{notice}</div> : null}

      {canManage && types.length === 0 ? (
        <section className="adm-card">
          <h2 className="adm-card__title">Get started</h2>
          <p className="adm-empty">Install the approved starter set of work types, then rename, recategorise, or deactivate any of them.</p>
          <form action={installStarterWorkTypesAction}>
            <button className="adm-btn adm-btn--primary" type="submit">Install starter work types</button>
          </form>
        </section>
      ) : null}

      {canManage ? (
        <section className="adm-card">
          <h2 className="adm-card__title">Add a work type</h2>
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
        <h2 className="adm-card__title">All work types</h2>
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
    </div>
  );
}
