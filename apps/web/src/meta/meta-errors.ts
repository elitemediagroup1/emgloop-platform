import { MetaApiError, type MetaOAuthStage } from '@emgloop/providers';

export const META_CONNECTION_MESSAGES: Record<string, string> = {
  SELECT_ACCOUNT: 'Choose the Facebook Page you want EMG Loop to analyze. Its linked professional Instagram account will also connect.',
  CONNECTED: 'Connected. Open Analytics and refresh to read the latest available data.',
  DISCONNECTED: 'Disconnected. EMG Loop deleted its stored token and stopped reading your accounts.',
  CONSENT_DECLINED: 'Authorization was cancelled. You can connect again whenever you are ready.',
  STATE_INVALID: 'This connection attempt expired or belongs to a different session. Start again in the same browser where you signed into Loop.',
  INVALID_REQUEST: 'Meta returned an incomplete connection request. Start a new connection from this page.',
  NOT_CONFIGURED: 'EMG needs to finish the server configuration before this account can connect.',
  PERMISSION_REQUIRED: 'Meta did not grant all requested analytics permissions. Allow every listed read permission. While this app is in testing, your Facebook login must also have a role on the Meta app.',
  ACCOUNT_UNAVAILABLE: 'That account could not be connected. It may already be linked, or you may need to disconnect your previous account first.',
  TOKEN_EXCHANGE_FAILED: 'Meta returned you to Loop, but the server could not exchange the authorization for access. EMG needs to check the Meta app credentials and callback configuration.',
  TOKEN_EXTENSION_FAILED: 'Meta authorized the login, but Loop could not obtain the required long-lived access. EMG needs to check the token configuration.',
  TOKEN_EXPIRY_UNAVAILABLE: 'Meta returned access without a usable expiration time. Loop did not save this authorization. EMG needs to check the token response.',
  IDENTITY_UNAVAILABLE: 'Meta authorized the login, but Loop could not verify the Facebook account identity. No new connection was saved.',
  PERMISSION_CHECK_FAILED: 'Loop could not verify the permissions Meta granted. No new connection was saved.',
  RATE_LIMITED: 'Meta temporarily limited authorization requests. Wait before starting another connection.',
  TOKEN_EXPIRED: 'Meta rejected this authorization as expired or invalid. Start a new connection from this page.',
  CONNECTION_SAVE_FAILED: 'Loop could not check or save this connection. EMG needs to investigate the server failure.',
  FAILED: 'This connection attempt failed. EMG needs to investigate before you retry.',
};

const stages: readonly MetaOAuthStage[] = ['CODE_EXCHANGE', 'LONG_LIVED_EXCHANGE', 'IDENTITY_READ', 'PERMISSIONS_READ'];
const invalidResponses = ['TOKEN_MISSING', 'EXPIRY_MISSING', 'IDENTITY_MISSING', 'PERMISSIONS_MISSING'] as const;
const boundedNumber = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : undefined;

// Strict projection: never log an exception, message, response, URL, token, code or identity.
export function metaCallbackFailure(error: unknown): { outcome: string; diagnostic: Record<string, string | number> } {
  if (!(error instanceof MetaApiError)) return { outcome: 'CONNECTION_SAVE_FAILED', diagnostic: { stage: 'LOOP_CALLBACK', failure: 'UNAVAILABLE' } };
  const detail = error.diagnostic;
  const stage = stages.find(value => value === detail.stage);
  const invalidResponse = invalidResponses.find(value => value === detail.invalidResponse);
  const failures = ['TOKEN_EXPIRED', 'PERMISSION_REQUIRED', 'RATE_LIMITED', 'UNAVAILABLE', 'METRIC_UNAVAILABLE'];
  const failure = failures.find(value => value === error.failure) ?? 'UNAVAILABLE';
  const diagnostic: Record<string, string | number> = { stage: stage ?? 'META_CALLBACK', failure };
  for (const key of ['httpStatus', 'graphCode', 'graphSubcode'] as const) {
    const value = boundedNumber(detail[key]);
    if (value !== undefined) diagnostic[key] = value;
  }
  if (invalidResponse) diagnostic.invalidResponse = invalidResponse;
  const outcome = failure === 'RATE_LIMITED' || failure === 'TOKEN_EXPIRED' || failure === 'PERMISSION_REQUIRED' ? failure
    : stage === 'CODE_EXCHANGE' ? 'TOKEN_EXCHANGE_FAILED'
    : stage === 'LONG_LIVED_EXCHANGE' ? invalidResponse === 'EXPIRY_MISSING' ? 'TOKEN_EXPIRY_UNAVAILABLE' : 'TOKEN_EXTENSION_FAILED'
    : stage === 'IDENTITY_READ' ? 'IDENTITY_UNAVAILABLE'
    : stage === 'PERMISSIONS_READ' ? 'PERMISSION_CHECK_FAILED' : 'FAILED';
  return { outcome, diagnostic };
}

export function metaFailureReference(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value) ? value : undefined;
}

export function metaConnectionMessage(outcome?: string, hasInstagram?: boolean): string | null {
  if (!outcome) return null;
  if (outcome === 'CONNECTED' && hasInstagram === false) return 'Facebook Page connected. Meta did not return a linked professional Instagram account for this Page. Facebook analytics can be refreshed; Instagram analytics are not connected.';
  return META_CONNECTION_MESSAGES[outcome] ?? META_CONNECTION_MESSAGES.FAILED!;
}
