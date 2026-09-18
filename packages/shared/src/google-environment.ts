// The Google Workspace connection's deployment configuration: the names, the validation and the
// redirect URI. PURE -- no I/O, no process, no clock.
//
// Architecture: docs/architecture/google-workspace-connection.md §11.9.
//
// WHY THIS IS HERE AND NOT IN THE WEB APP. Two runtimes now hold this configuration: the Next.js
// server, which serves a person connecting their account, and the scheduled Calendar cycle
// (DL-5), which runs outside Next and refreshes tokens for employees who are not looking. They
// must agree exactly on what "configured" means -- a second, laxer reader in the operations
// runtime is how a wrong key reaches the token sealer, and a wrong key marks every employee's
// connection EXPIRED. So the reader is one function, and each runtime supplies its own source.
//
//   GOOGLE_OAUTH_CLIENT_ID      the OAuth client id (Web application). Not a secret.
//   GOOGLE_OAUTH_CLIENT_SECRET  the client secret. SECRET, server-side only.
//   LOOP_GOOGLE_TOKEN_KEY       32 random bytes, base64. SECRET: seals refresh tokens at rest.
//
// None of them is ever NEXT_PUBLIC_, and nothing here reads an environment: a caller passes the
// source it is entitled to read, and gets back a value or a refusal. A partial or malformed
// configuration is INVALID and is never treated as "nearly configured".

/** Every variable the Google connection reads, by name. */
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

/** Exactly 32 bytes, base64 or base64url. Any other length is a different key, not a shorter one. */
function tokenKey(raw: string): Uint8Array | null {
  const text = raw.trim();
  if (!BASE64.test(text)) return null;
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  if (binary.length !== 32) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The redirect URI Google must send the person back to. Only an https origin, or plain
 * http on localhost for a separate development client (§11.3), is accepted.
 */
export function googleRedirectUri(origin: string): string | null {
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

/** Read a configuration out of a source the caller is entitled to read. Values never leave it. */
export function readGoogleEnvironment(source: GoogleEnvironmentSource, origin: string): GoogleEnvironment {
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
