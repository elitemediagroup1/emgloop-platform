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

// --- Governed historical baseline (Telegram) --------------------------------------------------
//
// Same authority as connecting (`sourceConnections:update`, re-derived from the session). Only the
// provider (which tile) and the chosen depth are read from the form; the organization and person are
// ALWAYS the signed session's. The depth is validated against the closed allowlist at the data layer
// (any other value -- including an "all-time" attempt -- is refused as INVALID). No worker call: the
// baseline is authorized in the database and the durable worker's baseline sweep picks it up.

function backBaseline(outcome: string, provider: string): never {
  const params = new URLSearchParams({ baseline: outcome });
  if (provider) params.set('provider', provider);
  redirect(`${CONNECTIONS_PATH}?${params.toString()}`);
}

export async function authorizeBaselineAction(formData: FormData): Promise<void> {
  const session = await requirePermission('sourceConnections', 'update');
  const provider = String(formData.get('provider') ?? '').trim();
  const windowDays = Number(String(formData.get('windowDays') ?? '').trim());
  const outcome = await sourceConnections().authorizeBaseline(
    { organizationId: session.organizationId, userId: session.userId, name: session.name },
    provider,
    windowDays,
  );
  revalidatePath(CONNECTIONS_PATH);
  backBaseline(outcome, provider);
}

export async function changeBaselineScopeAction(formData: FormData): Promise<void> {
  const session = await requirePermission('sourceConnections', 'update');
  const provider = String(formData.get('provider') ?? '').trim();
  const windowDays = Number(String(formData.get('windowDays') ?? '').trim());
  const outcome = await sourceConnections().changeBaselineScope(
    { organizationId: session.organizationId, userId: session.userId, name: session.name },
    provider,
    windowDays,
  );
  revalidatePath(CONNECTIONS_PATH);
  backBaseline(outcome, provider);
}

export async function revokeBaselineAction(formData: FormData): Promise<void> {
  const session = await requirePermission('sourceConnections', 'update');
  const provider = String(formData.get('provider') ?? '').trim();
  const outcome = await sourceConnections().revokeBaseline(
    { organizationId: session.organizationId, userId: session.userId, name: session.name },
    provider,
  );
  revalidatePath(CONNECTIONS_PATH);
  backBaseline(outcome, provider);
}

// --- Governed content processing (Telegram content-triage) ------------------------------------
//
// The employee's EXPLICIT, revocable consent for Loop to process message CONTENT with AI -- a separate
// act from connecting (which is about authorizing an account) and from the history baseline (which is
// who/when only). ONE consent, BUNDLED (no new toggle): it covers BOTH the recent historical window (the
// last N days already imported, read transiently to surface obligations still unresolved) AND new
// messages going forward. Same authority as connecting (`sourceConnections:update`, re-derived from the
// session). Only the provider (which tile) is read from the form; the organization and person are ALWAYS
// the signed session's. No worker call: consent is recorded in the database (and, on a COMPLETE baseline,
// the historical backfill is armed there) and the durable worker's content sweeps -- which run only when
// the deployment's AI runtime is enabled -- pick it up. A revoke stops BOTH immediately.

function backContent(outcome: string, provider: string): never {
  const params = new URLSearchParams({ content: outcome });
  if (provider) params.set('provider', provider);
  redirect(`${CONNECTIONS_PATH}?${params.toString()}`);
}

export async function authorizeContentAction(formData: FormData): Promise<void> {
  const session = await requirePermission('sourceConnections', 'update');
  const provider = String(formData.get('provider') ?? '').trim();
  const outcome = await sourceConnections().authorizeContent(
    { organizationId: session.organizationId, userId: session.userId, name: session.name },
    provider,
  );
  revalidatePath(CONNECTIONS_PATH);
  backContent(outcome, provider);
}

export async function revokeContentAction(formData: FormData): Promise<void> {
  const session = await requirePermission('sourceConnections', 'update');
  const provider = String(formData.get('provider') ?? '').trim();
  const outcome = await sourceConnections().revokeContent(
    { organizationId: session.organizationId, userId: session.userId, name: session.name },
    provider,
  );
  revalidatePath(CONNECTIONS_PATH);
  backContent(outcome, provider);
}
