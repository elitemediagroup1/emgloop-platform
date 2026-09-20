'use server';

// Telegram interactive-login actions. Each is called from the small client login widget, guards
// `sourceConnections:update` server-side from the session, and forwards the step to the durable
// worker over the signed channel. THE ORGANIZATION AND USER COME FROM THE SESSION, never the client;
// only the phone / code / password (which the person types into Loop's secure flow) are passed
// through, straight to the worker, and are never persisted or logged here.
//
// The worker holds the live MTProto login between steps and, on success, seals + stores the session.
// These actions return a plain step the widget renders; they never return or log a secret.

import { requirePermission } from '../auth/guard';
import { callWorker } from './worker-client';

export type TelegramLoginStep =
  | 'CODE_SENT'
  | 'PASSWORD_NEEDED'
  | 'AUTHORIZED'
  | 'FAILED'
  | 'NO_LOGIN_IN_PROGRESS'
  | 'NOT_AVAILABLE';

export interface TelegramLoginResult {
  readonly step: TelegramLoginStep;
  /** A plain, non-secret reason when the step is FAILED. */
  readonly reason?: string;
  readonly accountLabel?: string | null;
}

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  PHONE_INVALID: 'That phone number was not accepted. Check it and try again.',
  CODE_INVALID: 'That code was not correct. Try again.',
  CODE_EXPIRED: 'That code expired. Start again to get a new one.',
  PASSWORD_INVALID: 'That two-step password was not correct. Try again.',
  FLOOD_WAIT: 'Telegram is rate-limiting sign-ins right now. Wait a little and try again.',
  UNAVAILABLE: 'The connection could not be completed. Try again in a moment.',
};

function toResult(body: Record<string, unknown>): TelegramLoginResult {
  const status = (body?.status ?? {}) as { step?: string; reason?: string; accountLabel?: string | null };
  const step = status.step as TelegramLoginStep | undefined;
  if (!step) return { step: 'FAILED', reason: FAILURE_TEXT.UNAVAILABLE };
  if (step === 'FAILED') return { step, reason: FAILURE_TEXT[status.reason ?? 'UNAVAILABLE'] ?? FAILURE_TEXT.UNAVAILABLE };
  return { step, accountLabel: status.accountLabel ?? null };
}

async function drive(path: string, extra: Record<string, unknown>): Promise<TelegramLoginResult> {
  const session = await requirePermission('sourceConnections', 'update');
  const result = await callWorker(path, { organizationId: session.organizationId, userId: session.userId, ...extra });
  if (!result.ok) return { step: 'NOT_AVAILABLE', reason: result.reason === 'NOT_CONFIGURED' ? 'Telegram is not available on this deployment yet.' : 'The connection service could not be reached. Try again shortly.' };
  return toResult(result.body);
}

export async function startTelegramLoginAction(phone: string): Promise<TelegramLoginResult> {
  return drive('/telegram/login/start', { phone });
}

export async function submitTelegramCodeAction(code: string): Promise<TelegramLoginResult> {
  return drive('/telegram/login/code', { code });
}

export async function submitTelegramPasswordAction(password: string): Promise<TelegramLoginResult> {
  return drive('/telegram/login/password', { password });
}

export async function cancelTelegramLoginAction(): Promise<void> {
  const session = await requirePermission('sourceConnections', 'update');
  await callWorker('/telegram/login/cancel', { organizationId: session.organizationId, userId: session.userId });
}
