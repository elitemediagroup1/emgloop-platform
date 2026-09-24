// The TikTok OAuth port, assembled. ONE assembly, like the Google port beside it.
//
// IT HOLDS NOTHING. No environment is read, no key is stored, no token is logged. The caller
// passes a validated configuration (the web tier's `readTikTokEnvironment`) and, in tests, a
// recording network. The network is hardened the same way as Google's: `redirect: 'error'` so a
// redirected token endpoint is a failure rather than a surprise, and `cache: 'no-store'` so no
// framework caches a token response.

import {
  exchangeTikTokAuthorizationCode,
  readTikTokUserInfo,
  readTikTokVideoList,
  refreshTikTokAccessToken,
  revokeTikTokToken,
  tiktokAuthorizationUrl,
  tiktokUserInfoFields,
  type TikTokFetch,
} from '@emgloop/providers';

import type { TikTokOAuthPort } from './tiktok.service';

/** A validated TikTok client configuration. Never a partial one. */
export interface TikTokClientConfig {
  readonly clientKey: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

// `cache` is not in this package's RequestInit types (it has no DOM lib), and is a real,
// spec-valid field at runtime on every platform Loop runs on.
const NO_STORE = { cache: 'no-store' } as RequestInit;

export const tiktokFetch: TikTokFetch = (input, init) => fetch(input, { ...init, ...NO_STORE, redirect: 'error' });

export function createTikTokOAuthPort(config: TikTokClientConfig, deps: { readonly fetchImpl?: TikTokFetch } = {}): TikTokOAuthPort {
  const fetchImpl = deps.fetchImpl ?? tiktokFetch;
  const client = { clientKey: config.clientKey, clientSecret: config.clientSecret };
  return {
    authorizationUrl: (request) => tiktokAuthorizationUrl({ clientKey: config.clientKey, redirectUri: config.redirectUri, ...request }),
    exchangeCode: (code) => exchangeTikTokAuthorizationCode({ fetchImpl, client, redirectUri: config.redirectUri, code }),
    refresh: (refreshToken) => refreshTikTokAccessToken({ fetchImpl, client, refreshToken }),
    revoke: (token) => revokeTikTokToken({ fetchImpl, client, token }),
    userInfo: (accessToken, grantedScopes) => readTikTokUserInfo({ fetchImpl, accessToken, fields: tiktokUserInfoFields(grantedScopes) }),
    videoList: (accessToken, maxCount) => readTikTokVideoList({ fetchImpl, accessToken, maxCount }),
  };
}
