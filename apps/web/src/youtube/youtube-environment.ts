import 'server-only';

// Dedicated creator YouTube OAuth client. Never reuse GOOGLE_OAUTH_CLIENT_ID:
// that belongs to staff Google Workspace access.
import { YOUTUBE_CALLBACK_PATH, appOrigin, oauthRedirectUri, parseSealingKey } from '@emgloop/shared';

export const YOUTUBE_ENVIRONMENT = Object.freeze({
  clientId: 'YOUTUBE_CLIENT_ID',
  clientSecret: 'YOUTUBE_CLIENT_SECRET',
  tokenKey: 'LOOP_YOUTUBE_TOKEN_KEY',
} as const);

export type YouTubeEnvironment = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenKey: Uint8Array;
  readonly redirectUri: string;
};

const CLIENT_ID = /^[A-Za-z0-9._-]{8,200}\.apps\.googleusercontent\.com$/;
const SECRET = /^[\x21-\x7e]{8,512}$/;

export function readYouTubeEnvironment(source: Readonly<Record<string, string | undefined>> = process.env): YouTubeEnvironment | null {
  const clientId = source[YOUTUBE_ENVIRONMENT.clientId]?.trim();
  const clientSecret = source[YOUTUBE_ENVIRONMENT.clientSecret]?.trim();
  const keyText = source[YOUTUBE_ENVIRONMENT.tokenKey];
  if (!clientId || !clientSecret || !keyText || !CLIENT_ID.test(clientId) || !SECRET.test(clientSecret)) return null;
  const tokenKey = parseSealingKey(keyText);
  const redirectUri = oauthRedirectUri(appOrigin(), YOUTUBE_CALLBACK_PATH);
  if (!tokenKey || !redirectUri) return null;
  return { clientId, clientSecret, tokenKey, redirectUri };
}
