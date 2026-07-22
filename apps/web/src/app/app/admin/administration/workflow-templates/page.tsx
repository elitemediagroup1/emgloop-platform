// Administration › Workflow Templates — manage the reusable step sequences the
// team starts work from. These ARE Blueprints (kind='workflow_template'); the
// page speaks only business language. Authorized admins only (settings:view to
// see, settings:update to change). No Process Engine / Registry / Runtime /
// schema terminology on screen.

import Link from 'next/link';
import { requirePermission, hasPermission } from '../../../../../auth/guard';
import { repositories, RESPONSIBILITY_LABELS } from '@emgloop/database';
import TemplateEditor from './TemplateEditor';
import type { Step } from '../../work/_components/work-steps';
import {
  duplicateTemplateAction,
  setTemplateActiveAction,
} from './actions';

export const dynamic = 'force-dynamic';

export default async function WorkflowTemplatesPage({
  searchParams,
}: {
  searchParams?: { notice?: string; error?: string; edit?: string };
}) {
  const session = await requirePermission('settings', 'view');
  const canManage = await hasPermission('settings', 'update');
  const [templates, workTypes, members] = await Promise.all([
    repositories.work.listWorkflowTemplates(session.organizationId, { includeInactive: true }),
    repositories.work.listWorkTypes(session.organizationId, { includeInactive: true }),
    repositories.work.listActiveMembers(session.organizationId),
  ]);

  const notice = typeof searchParams?.notice === 'string' ? searchParams.notice : null;
  const error = typeof searchParams?.error === 'string' ? searchParams.error : null;
  const editId = typeof searchParams?.edit === 'string' ? searchParams.edit : null;

  const typeName = new Map(workTypes.map((t) => [t.id, t.name] as const));
  const responsibilities = Object.entries(RESPONSIBILITY_LABELS).map(([value, label]) => ({ value, label }));
  const memberOpts = members.map((m) => ({ id: m.id, name: m.name || m.email }));
  const typeOpts = workTypes.map((t) => ({ id: t.id, name: t.name }));

  // Editing / creating an editor pane? Only managers may open one.
  const isCreate = canManage && editId === 'new';
  const editTemplate = canManage && editId && editId !== 'new' ? templates.find((t) => t.id === editId) ?? null : null;
  const showEditor = isCreate || editTemplate != null;

  function toSteps(view: (typeof templates)[number]): Step[] {
    return view.steps.map((s) => ({
      name: s.name,
      instruction: s.instruction,
      mode: s.assignment.mode,
      specificUserId: s.assignment.specificUserId ?? '',
      responsibilityKey: s.assignment.responsibilityKey ?? '',
      completionConfirmation: s.completionConfirmation ?? '',
      completionNote: s.completionNote,
      notifyActive: s.notifyActive,
      notifyComplete: s.notifyComplete,
    }));
  }

  return (
    <div className="adm">
      <div className="loop-pagehead">
        <div className="loop-eyebrow">Administration</div>
        <h1 className="loop-title">Workflow Templates</h1>
        <p className="loop-subtitle">
          {templates.length} workflow{templates.length === 1 ? '' : 's'} · reusable step sequences the team starts work from.
        </p>
      </div>

      {error ? <div className="adm-banner adm-banner--error" role="alert">{error}</div> : null}
      {notice ? <div className="adm-banner adm-banner--ok" role="status">{notice}</div> : null}

      {showEditor ? (
        <div className="loop-os">
          <div className="sw2">
            {editTemplate ? (
              <TemplateEditor
                mode="edit"
                id={editTemplate.id}
                initialName={editTemplate.name}
                initialDescription={editTemplate.description ?? ''}
                initialWorkTypeIds={editTemplate.workTypeIds}
                initialSteps={toSteps(editTemplate)}
                workTypes={typeOpts}
                members={memberOpts}
                responsibilities={responsibilities}
              />
            ) : (
              <TemplateEditor mode="create" workTypes={typeOpts} members={memberOpts} responsibilities={responsibilities} />
            )}
          </div>
        </div>
      ) : (
        <>
          {canManage ? (
            <div className="adm-actionsbar">
              <Link href="?edit=new" className="adm-btn adm-btn--primary">Create workflow</Link>
            </div>
          ) : null}

          <section className="adm-card">
            <h2 className="adm-card__title">All workflows</h2>
            {templates.length === 0 ? (
              <p className="adm-empty">
                No saved workflows yet.{canManage ? ' Create one, or save a workflow while starting work.' : ''}
              </p>
            ) : (
              <div className="adm-tablewrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>Name</th><th>Steps</th><th>Work types</th><th>Status</th>
                      {canManage ? <th>Actions</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {templates.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <div className="adm-strong">{t.name}</div>
                          {t.description ? <div className="adm-faint">{t.description}</div> : null}
                        </td>
                        <td className="adm-faint">{t.stepCount}</td>
                        <td className="adm-faint">
                          {t.workTypeIds.length === 0
                            ? '—'
                            : t.workTypeIds.map((id) => typeName.get(id) ?? 'Unknown').join(', ')}
                        </td>
                        <td>
                          <span className={'adm-badge adm-badge--' + (t.active ? 'ok' : 'off')}>{t.active ? 'Active' : 'Inactive'}</span>
                        </td>
                        {canManage ? (
                          <td>
                            <div className="adm-inline">
                              <Link href={`?edit=${t.id}`} className="adm-btn">Edit</Link>
                              <form action={duplicateTemplateAction}>
                                <input type="hidden" name="id" value={t.id} />
                                <button className="adm-btn" type="submit">Duplicate</button>
                              </form>
                              <form action={setTemplateActiveAction}>
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
        </>
      )}
    </div>
  );
}
