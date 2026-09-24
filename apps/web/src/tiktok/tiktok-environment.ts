// The ONE module in the web application that reads the TikTok Login Kit connection's
// deployment environment. SERVER ONLY, and fenced like `google-environment.ts`: no other file
// in `apps/web`, `packages/` or `scripts/` names these variables (test/tiktok-login-kit.test.tsx),
// none of them is ever NEXT_PUBLIC_, and no client component can reach this module.
//
//   TIKTOK_CLIENT_KEY       the TikTok app's client key (Login Kit, Web). Not a secret.
//   TIKTOK_CLIENT_SECRET    the client secret. SECRET, server-side only.
//   LOOP_TIKTOK_TOKEN_KEY   32 random bytes, base64. SECRET: seals both TikTok tokens at rest.
//
// OFF UNTIL FULLY CONFIGURED. With none of the three set, the state is NOT_CONFIGURED and every
// connect attempt is refused before anything is stored. A partial or malformed configuration is
// INVALID and refused the same way. Values never leave this module except into the OAuth port
// and the sealer.
//
// The two rules this shares with Google's reader live in @emgloop/shared: the 32-byte key parser
// and the redirect URI as canonical origin plus the one static callback path.

import 'server-only';

import { TIKTOK_CALLBACK_PATH, appOrigin, oauthRedirectUri, parseSealingKey } from '@emgloop/shared';

/** Every variable the TikTok connection reads, by name. */
export const TIKTOK_ENVIRONMENT = Object.freeze({
  clientKey: 'TIKTOK_CLIENT_KEY',
  clientSecret: 'TIKTOK_CLIENT_SECRET',
  tokenKey: 'LOOP_TIKTOK_TOKEN_KEY',
} as const);

export { TIKTOK_CALLBACK_PATH };

export type TikTokEnvironmentSource = Readonly<Record<string, string | undefined>>;

export type TikTokEnvironment =
  | {
      readonly state: 'CONFIGURED';
      readonly clientKey: string;
      readonly clientSecret: string;
      readonly redirectUri: string;
      readonly tokenKey: Uint8Array;
    }
  | { readonly state: 'NOT_CONFIGURED' | 'INVALID' };

const CLIENT_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const SECRET = /^[\x21-\x7e]{8,512}$/;

function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** This deployment's callback URI, from its canonical origin: registered on the TikTok app exactly as returned. */
export function tiktokRedirectUri(origin: string = appOrigin()): string | null {
  return oauthRedirectUri(origin, TIKTOK_CALLBACK_PATH);
}

/** Read a configuration out of a source the caller is entitled to read. Values never leave it. */
export function readTikTokEnvironment(source: TikTokEnvironmentSource = process.env, origin: string = appOrigin()): TikTokEnvironment {
  const clientKey = source[TIKTOK_ENVIRONMENT.clientKey];
  const clientSecret = source[TIKTOK_ENVIRONMENT.clientSecret];
  const key = source[TIKTOK_ENVIRONMENT.tokenKey];
  const set = [clientKey, clientSecret, key].filter(present).length;
  if (set === 0) return { state: 'NOT_CONFIGURED' };
  if (set !== 3 || !present(clientKey) || !present(clientSecret) || !present(key)) return { state: 'INVALID' };
  if (!CLIENT_KEY.test(clientKey.trim()) || !SECRET.test(clientSecret.trim())) return { state: 'INVALID' };
  const sealingKey = parseSealingKey(key);
  const redirectUri = tiktokRedirectUri(origin);
  if (!sealingKey || !redirectUri) return { state: 'INVALID' };
  return { state: 'CONFIGURED', clientKey: clientKey.trim(), clientSecret: clientSecret.trim(), redirectUri, tokenKey: sealingKey };
}
