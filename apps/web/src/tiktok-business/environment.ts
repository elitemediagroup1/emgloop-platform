import 'server-only';
import { appOrigin, oauthRedirectUri, parseSealingKey } from '@emgloop/shared';
import { businessAuthorizationUrl, type TikTokBusinessKind } from '@emgloop/providers';
export const BUSINESS_CALLBACKS = { TTO: '/api/integrations/tiktok-business/callback', CREATOR: '/api/integrations/tiktok-business/creator-callback' } as const;
export function readBusinessEnvironment(kind: TikTokBusinessKind, source: Readonly<Record<string, string | undefined>> = process.env, origin: string = appOrigin()) {
  const appId = source.TIKTOK_BUSINESS_APP_ID?.trim();
  const secret = source.TIKTOK_BUSINESS_APP_SECRET?.trim();
  const key = parseSealingKey(source.LOOP_TIKTOK_BUSINESS_TOKEN_KEY ?? '');
  const authorizationUrl = source[kind === 'TTO' ? 'TIKTOK_BUSINESS_TTO_AUTHORIZATION_URL' : 'TIKTOK_BUSINESS_CREATOR_AUTHORIZATION_URL']?.trim();
  const redirectUri = oauthRedirectUri(origin, BUSINESS_CALLBACKS[kind]);
  if (!appId || !/^\d{5,32}$/.test(appId) || !secret || !/^[\x21-\x7e]{8,512}$/.test(secret) || !key || !authorizationUrl || !redirectUri) return null;
  try {
    const url = new URL(businessAuthorizationUrl(authorizationUrl, redirectUri, 'validation'));
    // Templates are copied from THIS app's My Apps page. Reject mismatched app ids and saved codes.
    const id = url.searchParams.get('app_id') ?? url.searchParams.get('client_id') ?? url.searchParams.get('client_key');
    if (id !== appId || ['code', 'auth_code', 'access_token', 'secret', 'client_secret'].some(k => url.searchParams.has(k))) return null;
  } catch { return null; }
  return { appId, secret, key, authorizationUrl, redirectUri };
}
