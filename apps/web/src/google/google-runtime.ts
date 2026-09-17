// The Google Workspace connection, assembled for a web request. SERVER ONLY.
//
// This is where the pieces meet: the deployment's client credentials and token key (read
// by google-environment.ts and nowhere else), Google's OAuth endpoints (@emgloop/providers),
// the token sealer, and the IAM decision for `googleWorkspace`. Nothing here decides
// anything those pieces do not already decide.
//
// WITH THE DEFAULT ENVIRONMENT NOTHING CONNECTS. No client or key is configured, so every
// connect attempt is refused as NOT_CONFIGURED before anything is stored.

import 'server-only';

import {
  GoogleTokenSealer,
  GoogleWorkspaceService,
  prisma,
  repositories,
  type GoogleActor,
  type GoogleOAuthPort,
  type GoogleRevocation,
} from '@emgloop/database';
import {
  checkGoogleIdTokenClaims,
  exchangeGoogleAuthorizationCode,
  googleAuthorizationUrl,
  refreshGoogleAccessToken,
  revokeGoogleToken,
} from '@emgloop/providers';
import type { GoogleConnectOutcome, GoogleConnectReturnTarget } from '@emgloop/shared';

import { CONNECTIONS_PATH, ONBOARDING_GOOGLE_PATH } from '../auth/landing';
import { readGoogleEnvironment, type GoogleEnvironment } from './google-environment';

function oauthPort(env: Extract<GoogleEnvironment, { state: 'CONFIGURED' }>): GoogleOAuthPort {
  const client = { clientId: env.clientId, clientSecret: env.clientSecret };
  const fetchImpl = (input: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
    fetch(input, { ...init, cache: 'no-store', redirect: 'error' });
  return {
    authorizationUrl: (request) => googleAuthorizationUrl({ clientId: env.clientId, redirectUri: env.redirectUri, ...request }),
    exchangeCode: (code) => exchangeGoogleAuthorizationCode({ fetchImpl, client, redirectUri: env.redirectUri, code }),
    refresh: (refreshToken) => refreshGoogleAccessToken({ fetchImpl, client, refreshToken }),
    revoke: (token) => revokeGoogleToken({ fetchImpl, token }),
    checkIdToken: (idToken, expected) => checkGoogleIdTokenClaims(idToken, { clientId: env.clientId, ...expected }),
  };
}

/** The connection lifecycle for a signed-in person. The principal is always the session's. */
export function googleWorkspace(): GoogleWorkspaceService {
  const env = readGoogleEnvironment();
  return new GoogleWorkspaceService(prisma, {
    configured: env.state === 'CONFIGURED' ? { oauth: oauthPort(env), sealer: new GoogleTokenSealer(env.tokenKey) } : null,
    authorize: (principal, action) =>
      repositories.iam.can({ organizationId: principal.organizationId, userId: principal.userId, resource: 'googleWorkspace', action }),
  });
}

/**
 * After a member was disabled or removed (the credential is already deleted, in the same
 * transaction), ask Google to revoke it. Never throws: offboarding has already happened,
 * and an unconfirmed revocation is recorded on the connection.
 */
export async function finishGoogleOffboarding(revocation: GoogleRevocation | null, actor: GoogleActor): Promise<void> {
  if (!revocation) return;
  try {
    await googleWorkspace().finishRevocation(revocation, actor);
  } catch {
    // Loop's copy is gone either way; the connection keeps no confirmation.
  }
}

/** Where a connect, callback or disconnect returns the person, with its outcome. */
export function googleReturnPath(target: GoogleConnectReturnTarget, outcome: GoogleConnectOutcome, extra?: Record<string, string>): string {
  const params = new URLSearchParams({ google: outcome, ...(extra ?? {}) });
  return `${target === 'ONBOARDING' ? ONBOARDING_GOOGLE_PATH : CONNECTIONS_PATH}?${params.toString()}`;
}
