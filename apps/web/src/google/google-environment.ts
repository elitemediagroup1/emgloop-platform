// The ONE module in the web application that reads the Google Workspace connection's
// deployment environment. SERVER ONLY, and fenced like `ai-environment.ts` and
// `brain-environment.ts`: no other file in `apps/web` or `packages/` reads these names
// (test/google-workspace.test.tsx), none of them is ever NEXT_PUBLIC_, and no client
// component can reach this module.
//
// Architecture: docs/architecture/google-workspace-connection.md §11.9.
//
// WHAT IT STILL OWNS: binding this runtime's `process.env` and this deployment's canonical
// origin to the shared reader. WHAT IT NO LONGER OWNS: the names, the validation rules and
// the redirect URI, which moved to `@emgloop/shared` when the scheduled Calendar cycle (DL-5)
// became a second runtime holding the same configuration. One reader, two sources -- because
// two readers is how a laxer one lets a wrong token key reach the sealer.
//
// OFF UNTIL FULLY CONFIGURED. With none of the three set, the state is NOT_CONFIGURED and
// every connect attempt is refused before anything is stored. A partial or malformed
// configuration is INVALID and refused the same way. Values never leave this module except
// into the OAuth client and the sealer.

import 'server-only';

import {
  GOOGLE_CALLBACK_PATH,
  GOOGLE_ENVIRONMENT,
  appOrigin,
  googleRedirectUri as redirectUriFor,
  readGoogleEnvironment as readGoogleEnvironmentFrom,
  type GoogleEnvironment,
  type GoogleEnvironmentSource,
} from '@emgloop/shared';

export { GOOGLE_CALLBACK_PATH, GOOGLE_ENVIRONMENT };
export type { GoogleEnvironment, GoogleEnvironmentSource };

/** This deployment's callback URI, from its canonical origin. */
export function googleRedirectUri(origin: string = appOrigin()): string | null {
  return redirectUriFor(origin);
}

/** This runtime's Google configuration: its own environment, its own origin, one reader. */
export function readGoogleEnvironment(source: GoogleEnvironmentSource = process.env, origin: string = appOrigin()): GoogleEnvironment {
  return readGoogleEnvironmentFrom(source, origin);
}
