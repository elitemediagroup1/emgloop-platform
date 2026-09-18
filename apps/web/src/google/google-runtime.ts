// The Google Workspace connection, assembled for a web request. SERVER ONLY.
//
// This is where the pieces meet: the deployment's client credentials and token key (read
// by google-environment.ts and nowhere else), Google's OAuth endpoints and signing keys
// (@emgloop/providers), the token sealer, and the IAM decision for `googleWorkspace`. Nothing here decides
// anything those pieces do not already decide.
//
// WITH THE DEFAULT ENVIRONMENT NOTHING CONNECTS. No client or key is configured, so every
// connect attempt is refused as NOT_CONFIGURED before anything is stored.

import 'server-only';

import {
  GoogleTokenSealer,
  GoogleWorkspaceService,
  createGoogleOAuthPort,
  googleFetch,
  prisma,
  repositories,
  type GoogleActor,
  type GoogleRevocation,
} from '@emgloop/database';
import { GoogleSigningKeys } from '@emgloop/providers';
import type { GoogleConnectOutcome, GoogleConnectReturnTarget } from '@emgloop/shared';

import { CONNECTIONS_PATH, ONBOARDING_GOOGLE_PATH } from '../auth/landing';
import { readGoogleEnvironment, type GoogleEnvironment } from './google-environment';

// Google's signing keys, one set per server instance and shared by every request it serves,
// so Google's cache headers -- not each request -- decide when they are fetched again. The port
// itself, and the hardened fetch inside it, are assembled in @emgloop/database: the scheduled
// Calendar cycle builds the same one, and one assembly cannot drift from itself.
let signingKeys: GoogleSigningKeys | null = null;
export function googleSigningKeys(): GoogleSigningKeys {
  signingKeys ??= new GoogleSigningKeys({ fetchImpl: googleFetch });
  return signingKeys;
}

/** The connection lifecycle for a signed-in person. The principal is always the session's. */
export function googleWorkspace(): GoogleWorkspaceService {
  const env = readGoogleEnvironment();
  return new GoogleWorkspaceService(prisma, {
    configured:
      env.state === 'CONFIGURED'
        ? { oauth: createGoogleOAuthPort(env, { signingKeys: googleSigningKeys() }), sealer: new GoogleTokenSealer(env.tokenKey) }
        : null,
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
