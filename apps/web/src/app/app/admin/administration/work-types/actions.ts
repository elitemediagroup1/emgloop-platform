'use server';

// Work Types administration — create / rename / recategorise / activate /
// deactivate / reorder the org's Work Types (which are Blueprints), plus a
// one-click install of the approved starter catalog. Only authorized admins:
// every action guards on settings:update (OWNER/ADMIN), and the org ALWAYS comes
// from the signed session, never the form.

import { redirect } from 'next/navigation';
import { repositories, WORK_TYPE_CATALOG, WORK_PRIORITIES, WORK_FIELD_TYPES, type WorkFieldDef, type WorkFieldType } from '@emgloop/database';
import { requirePermission } from '../../../../../auth/guard';

const PATH = '/app/admin/administration/work-types';

function backTo(message: string, kind: 'notice' | 'error'): string {
  return PATH + '?' + kind + '=' + encodeURIComponent(message);
}

function fieldsBackTo(id: string, message: string, kind: 'notice' | 'error'): string {
  return `${PATH}?fields=${encodeURIComponent(id)}&${kind}=${encodeURIComponent(message)}`;
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
}

function priorityOrNormal(v: string): string {
  return (WORK_PRIORITIES as readonly string[]).includes(v) ? v : 'normal';
}

export async function createWorkTypeAction(formData: FormData): Promise<void> {
  const session = await requirePermission('settings', 'update');
  const name = String(formData.get('name') ?? '').trim();
  const category = String(formData.get('category') ?? '').trim() || 'General';
  const responsibility = String(formData.get('responsibility') ?? '').trim() || null;
  const defaultPriority = priorityOrNormal(String(formData.get('defaultPriority') ?? 'normal'));

  let result: { message: string; kind: 'notice' | 'error' };
  if (!name) {
    result = { message: 'Give the work type a name.', kind: 'error' };
  } else {
    await repositories.work.createWorkType({
      organizationId: session.organizationId,
      createdByUserId: session.userId,
      name,
      category,
      responsibility,
      defaultPriority,
    });
    await repositories.audit.record({
      organizationId: session.organizationId,
      userId: session.userId,
      actorName: session.name,
      action: 'work_type.created',
      entityType: 'work_type',
      entityId: name,
      metadata: { category },
    });
    result = { message: `Work type “${name}” added.`, kind: 'notice' };
  }
  redirect(backTo(result.message, result.kind));
}

export async function updateWorkTypeAction(formData: FormData): Promise<void> {
  const session = await requirePermission('settings', 'update');
  const id = String(formData.get('id') ?? '').trim();
  if (!id) redirect(backTo('No work type selected.', 'error'));
  await repositories.work.updateWorkType(session.organizationId, id, {
    name: String(formData.get('name') ?? '').trim() || undefined,
    category: String(formData.get('category') ?? '').trim() || undefined,
    responsibility: String(formData.get('responsibility') ?? '').trim() || null,
    defaultPriority: priorityOrNormal(String(formData.get('defaultPriority') ?? 'normal')),
  });
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'work_type.updated',
    entityType: 'work_type',
    entityId: id,
  });
  redirect(backTo('Work type updated.', 'notice'));
}

export async function setWorkTypeActiveAction(formData: FormData): Promise<void> {
  const session = await requirePermission('settings', 'update');
  const id = String(formData.get('id') ?? '').trim();
  const active = String(formData.get('active') ?? '') === 'true';
  if (!id) redirect(backTo('No work type selected.', 'error'));
  await repositories.work.setWorkTypeActive(session.organizationId, id, active);
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: active ? 'work_type.activated' : 'work_type.deactivated',
    entityType: 'work_type',
    entityId: id,
  });
  redirect(backTo(active ? 'Work type activated.' : 'Work type deactivated.', 'notice'));
}

export async function reorderWorkTypeAction(formData: FormData): Promise<void> {
  const session = await requirePermission('settings', 'update');
  const id = String(formData.get('id') ?? '').trim();
  const direction = String(formData.get('direction') ?? ''); // 'up' | 'down'
  if (!id || (direction !== 'up' && direction !== 'down')) redirect(backTo('Nothing to reorder.', 'error'));

  const types = await repositories.work.listWorkTypes(session.organizationId, { includeInactive: true });
  const idx = types.findIndex((t) => t.id === id);
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (idx >= 0 && swapWith >= 0 && swapWith < types.length) {
    const a = types[idx]!;
    const b = types[swapWith]!;
    // Swap sort order; normalise to index so equal/legacy sortOrders still move.
    await repositories.work.updateWorkType(session.organizationId, a.id, { sortOrder: swapWith });
    await repositories.work.updateWorkType(session.organizationId, b.id, { sortOrder: idx });
  }
  redirect(backTo('Order updated.', 'notice'));
}

export async function installStarterWorkTypesAction(): Promise<void> {
  const session = await requirePermission('settings', 'update');
  const catalog = WORK_TYPE_CATALOG.map((c) => ({
    key: c.key, name: c.name, category: c.category, responsibility: c.responsibility, defaultPriority: c.defaultPriority,
  }));
  const { created, skipped } = await repositories.work.installStarterWorkTypes(
    session.organizationId,
    session.userId,
    catalog,
  );
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'work_type.starter_installed',
    entityType: 'work_type',
    entityId: 'catalog',
    metadata: { created, skipped },
  });
  redirect(backTo(
    created > 0 ? `Added ${created} starter work type${created === 1 ? '' : 's'}.` : 'All starter work types were already installed.',
    'notice',
  ));
}

// Save the type-specific field definitions for a Work Type. Admins configure the
// fields Start Work + Work Detail render — with no code change. Keys are stable
// identifiers derived from the label when absent, de-duplicated across the set.
export async function saveWorkTypeFieldsAction(formData: FormData): Promise<void> {
  const session = await requirePermission('settings', 'update');
  const id = String(formData.get('id') ?? '').trim();
  if (!id) redirect(backTo('No work type selected.', 'error'));

  let raw: unknown[] = [];
  try {
    const parsed = JSON.parse(String(formData.get('fields') ?? '[]'));
    if (Array.isArray(parsed)) raw = parsed;
  } catch {
    raw = [];
  }

  const usedKeys = new Set<string>();
  const fields: WorkFieldDef[] = [];
  let missingLabel = false;
  raw.forEach((r, i) => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    if (!label) {
      missingLabel = true;
      return;
    }
    const type: WorkFieldType = typeof o.type === 'string' && (WORK_FIELD_TYPES as readonly string[]).includes(o.type)
      ? (o.type as WorkFieldType)
      : 'short_text';
    // Stable key: keep a provided one, else derive from the label. De-dup.
    let key = typeof o.key === 'string' && o.key.trim() ? slugify(o.key) : slugify(label);
    if (usedKeys.has(key)) {
      let n = 2;
      while (usedKeys.has(`${key}_${n}`)) n += 1;
      key = `${key}_${n}`;
    }
    usedKeys.add(key);
    const options = type === 'dropdown' && typeof o.options === 'string'
      ? o.options.split(',').map((x) => x.trim()).filter(Boolean)
      : Array.isArray(o.options)
        ? (o.options as unknown[]).map(String)
        : undefined;
    fields.push({
      key,
      label,
      helper: typeof o.helper === 'string' && o.helper.trim() ? o.helper.trim() : undefined,
      type,
      required: o.required === true || o.required === 'true',
      options,
      sortOrder: i,
      active: o.active !== false && o.active !== 'false',
    });
  });

  if (missingLabel) {
    redirect(fieldsBackTo(id, 'Every field needs a label. The unlabelled ones were not saved.', 'error'));
  }

  await repositories.work.setWorkTypeFields(session.organizationId, id, fields);
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'work_type.fields_updated',
    entityType: 'work_type',
    entityId: id,
    metadata: { fields: fields.length },
  });
  redirect(fieldsBackTo(id, `Saved ${fields.length} field${fields.length === 1 ? '' : 's'}.`, 'notice'));
}
