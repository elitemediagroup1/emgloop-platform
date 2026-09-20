// The Teams/Telegram connection lifecycle, assembled for a web request. SERVER ONLY.
//
// The sibling of google-runtime.ts: it binds this deployment's connection secret key (read by
// connection-environment.ts and nowhere else) and the IAM decision for `sourceConnections` to the
// provider-neutral SourceConnectionService. Nothing here decides anything those pieces do not.
//
// WITH THE DEFAULT ENVIRONMENT NOTHING CONNECTS. No key or enabled provider is configured, so the
// service is built with `configured: null` and every connect attempt is refused as NOT_CONFIGURED
// before anything is stored.

import 'server-only';

import { ConnectionSecretSealer, SourceConnectionService, prisma, repositories } from '@emgloop/database';

import { readConnectionEnvironment } from './connection-environment';

/** The connection lifecycle for a signed-in person. The principal is always the session's. */
export function sourceConnections(): SourceConnectionService {
  const env = readConnectionEnvironment();
  return new SourceConnectionService(prisma, {
    configured:
      env.state === 'CONFIGURED'
        ? { sealer: new ConnectionSecretSealer(env.secretKey), providers: env.providers }
        : null,
    authorize: (principal, action) =>
      repositories.iam.can({ organizationId: principal.organizationId, userId: principal.userId, resource: 'sourceConnections', action }),
  });
}
