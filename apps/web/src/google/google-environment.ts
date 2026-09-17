// The ONE module that reads the Google Workspace connection's deployment environment.
//
// SERVER ONLY, and fenced like `ai-environment.ts` and `brain-environment.ts`: no other
// file reads these names (test/google-workspace.test.tsx), none of them is ever
// NEXT_PUBLIC_, and no client component can reach this module.
//
// Architecture: docs/architecture/google-workspace-connection.md §11.9.
//
//   GOOGLE_OAUTH_CLIENT_ID      the OAuth client id (Web application). Not a secret.
//   GOOGLE_OAUTH_CLIENT_SECRET  the client secret. SECRET: server-only Netlify variable.
//   LOOP_GOOGLE_TOKEN_KEY       32 random bytes, base64. SECRET: seals refresh tokens at rest.
//
// The redirect URI is not configured separately: it is the canonical application origin
// (`APP_URL`, see @emgloop/shared app-origin.ts) plus GOOGLE_CALLBACK_PATH, and must be
// registered on the Google client exactly as that.
//
// OFF UNTIL FULLY CONFIGURED. With none of the three set -- every deployment today -- the
// state is NOT_CONFIGURED and every connect attempt is refused before anything is stored.
// A partial or malformed configuration is INVALID and refused the same way. Values never
// leave this module except into the OAuth client and the sealer.

import 'server-only';

import { appOrigin } from '@emgloop/shared';

/** Every variable this module reads, by name. */
export const GOOGLE_ENVIRONMENT = Object.freeze({
  clientId: 'GOOGLE_OAUTH_CLIENT_ID',
  clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET',
  tokenKey: 'LOOP_GOOGLE_TOKEN_KEY',
} as const);

/** The one callback route, for every capability. */
export const GOOGLE_CALLBACK_PATH = '/api/integrations/google/callback';

export type GoogleEnvironmentSource = Readonly<Record<string, string | undefined>>;

export type GoogleEnvironment =
  | {
      readonly state: 'CONFIGURED';
      readonly clientId: string;
      readonly clientSecret: string;
      readonly redirectUri: string;
      readonly tokenKey: Uint8Array;
    }
  | { readonly state: 'NOT_CONFIGURED' | 'INVALID' };

const CLIENT_ID = /^[A-Za-z0-9._-]{8,200}\.apps\.googleusercontent\.com$/;
const SECRET = /^[\x21-\x7e]{8,512}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$|^[A-Za-z0-9_-]+$/;

function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function tokenKey(raw: string): Uint8Array | null {
  const text = raw.trim();
  if (!BASE64.test(text)) return null;
  const bytes = Buffer.from(text, text.includes('-') || text.includes('_') ? 'base64url' : 'base64');
  return bytes.byteLength === 32 ? new Uint8Array(bytes) : null;
}

/**
 * The redirect URI Google must send the person back to. Only an https origin, or plain
 * http on localhost for a separate development client (§11.3), is accepted.
 */
export function googleRedirectUri(origin: string = appOrigin()): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  return `${url.origin}${GOOGLE_CALLBACK_PATH}`;
}

export function readGoogleEnvironment(source: GoogleEnvironmentSource = process.env, origin?: string): GoogleEnvironment {
  const clientId = source[GOOGLE_ENVIRONMENT.clientId];
  const clientSecret = source[GOOGLE_ENVIRONMENT.clientSecret];
  const key = source[GOOGLE_ENVIRONMENT.tokenKey];
  const set = [clientId, clientSecret, key].filter(present).length;
  if (set === 0) return { state: 'NOT_CONFIGURED' };
  if (set !== 3 || !present(clientId) || !present(clientSecret) || !present(key)) return { state: 'INVALID' };
  if (!CLIENT_ID.test(clientId.trim()) || !SECRET.test(clientSecret.trim())) return { state: 'INVALID' };
  const sealingKey = tokenKey(key);
  const redirectUri = googleRedirectUri(origin);
  if (!sealingKey || !redirectUri) return { state: 'INVALID' };
  return { state: 'CONFIGURED', clientId: clientId.trim(), clientSecret: clientSecret.trim(), redirectUri, tokenKey: sealingKey };
}
