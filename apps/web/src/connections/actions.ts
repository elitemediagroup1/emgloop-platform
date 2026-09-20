'use server';

// Connections server actions: begin connecting, or disconnect, one source (Teams, Telegram).
//
// THE PERSON AND ORGANIZATION ARE THE SIGNED SESSION'S, ALWAYS. requirePermission re-derives them
// from the session cookie and enforces `sourceConnections:update` server-side before anything runs
// (the button being visible is not authorization). Only the provider -- which tile the person
// pressed, never a tenant identity -- is read from the form, and the service ignores it unless it
// names a known provider.
//
// Every outcome is a plain code carried back on the URL; nothing here is a secret, and the actual
// authentication happens out of band in the durable worker, not in this request. With the default
// environment the service returns NOT_CONFIGURED and nothing is written.

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { requirePermission } from '../auth/guard';
import { CONNECTIONS_PATH } from '../auth/landing';
import { sourceConnections } from './source-connection-runtime';
import { callWorker } from './worker-client';

function back(outcome: string, provider: string): never {
  const params = new URLSearchParams({ connection: outcome });
  if (provider) params.set('provider', provider);
  redirect(`${CONNECTIONS_PATH}?${params.toString()}`);
}

export async function beginConnectSourceAction(formData: FormData): Promise<void> {
  const session = await requirePermission('sourceConnections', 'update');
  const provider = String(formData.get('provider') ?? '').trim();
  const outcome = await sourceConnections().beginConnect(
    { organizationId: session.organizationId, userId: session.userId, name: session.name },
    provider,
  );
  revalidatePath(CONNECTIONS_PATH);
  back(outcome, provider);
}

export async function disconnectSourceAction(formData: FormData): Promise<void> {
  const session = await requirePermission('sourceConnections', 'update');
  const provider = String(formData.get('provider') ?? '').trim();
  // Telegram holds a live session in the worker: ask it to revoke at Telegram AND clear the stored
  // credential. If the worker cannot be reached, still clear the stored credential locally so Loop
  // stops using it (the provider-side session may linger until it is revoked there).
  let outcome: string;
  if (provider === 'TELEGRAM') {
    const viaWorker = await callWorker('/telegram/disconnect', { organizationId: session.organizationId, userId: session.userId });
    outcome = viaWorker.ok
      ? String((viaWorker.body as { outcome?: string }).outcome ?? 'DISCONNECTED')
      : await sourceConnections().disconnect({ organizationId: session.organizationId, userId: session.userId, name: session.name }, provider);
  } else {
    outcome = await sourceConnections().disconnect({ organizationId: session.organizationId, userId: session.userId, name: session.name }, provider);
  }
  revalidatePath(CONNECTIONS_PATH);
  back(outcome, provider);
}
