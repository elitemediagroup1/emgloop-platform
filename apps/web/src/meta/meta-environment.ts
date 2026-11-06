import 'server-only';
import { appOrigin, oauthRedirectUri, parseSealingKey } from '@emgloop/shared';
import type { MetaConfig } from '@emgloop/providers';
export const META_CALLBACK_PATH = '/api/integrations/meta/callback';
export function readMetaEnvironment(source: Readonly<Record<string, string | undefined>> = process.env): { config: MetaConfig; key: Uint8Array } | null {
  const appId = source.META_APP_ID?.trim();
  const appSecret = source.META_APP_SECRET?.trim();
  const key = parseSealingKey(source.LOOP_META_TOKEN_KEY ?? '');
  const version = source.META_GRAPH_VERSION?.trim() || 'v25.0';
  const redirectUri = oauthRedirectUri(appOrigin(), META_CALLBACK_PATH);
  const configId = source.META_LOGIN_CONFIG_ID?.trim();
  if (!appId || !/^\d+$/.test(appId) || !appSecret || !/^[a-fA-F0-9]{32}$/.test(appSecret) || !key || !redirectUri || !/^v\d+\.0$/.test(version) || (configId && !/^\d+$/.test(configId))) return null;
  return { config: { appId, appSecret, version, redirectUri, ...(configId ? { configId } : {}) }, key };
}
