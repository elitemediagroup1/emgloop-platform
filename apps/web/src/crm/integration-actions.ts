'use server';


// Integration server actions — Sprint 10 (Loop Intelligence Foundation).
//
// Mutations for the Integrations management page. Every action:
//  - enforces deny-by-default permission check (integrations resource)
//  - persists through the @emgloop/database IntegrationRepository
//  - writes an immutable AuditLog entry via repositories.audit.record()
//  - performs configuration only — no real API calls, no credentials


import { revalidatePath } from 'next/cache';
import { repositories } from '@emgloop/database';
import { requirePermission } from '../auth/guard';


export async function createIntegrationAction(formData: FormData): Promise<void> {
  const session = await requirePermission('integrations', 'create');
  const orgId = session.organizationId;
  if (!orgId) return;

  const category = formData.get('category') as string;
  const provider = formData.get('provider') as string;
  const displayName = (formData.get('displayName') as string | null) || undefined;

  if (!category || !provider) return;

  const conn = await repositories.integrations.createConnection({
    organizationId: orgId,
    category,
    provider,
    displayName,
  });

  await repositories.audit.record({
    organizationId: orgId,
    userId: session.userId,
    action: 'integration.connection_created',
    entityType: 'ProviderConnection',
    entityId: conn.id,
    after: { category, provider, displayName },
  });

  revalidatePath('/crm/integrations');
}


export async function deleteIntegrationAction(formData: FormData): Promise<void> {
  const session = await requirePermission('integrations', 'delete');
  const orgId = session.organizationId;
  if (!orgId) return;

  const connectionId = formData.get('connectionId') as string;
  if (!connectionId) return;

  const existing = await repositories.integrations.getConnection(orgId, connectionId);
  if (!existing) return;

  await repositories.integrations.deleteConnection(orgId, connectionId);

  await repositories.audit.record({
    organizationId: orgId,
    userId: session.userId,
    action: 'integration.connection_deleted',
    entityType: 'ProviderConnection',
    entityId: connectionId,
    before: { provider: existing.provider, category: existing.category },
  });

  revalidatePath('/crm/integrations');
}
