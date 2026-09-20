// The Teams/Telegram connection lifecycle + the worker control client, assembled for a web request.
// SERVER ONLY. Sibling of google-runtime.ts. With the default environment nothing connects
// (configured: null) and every begin is refused as NOT_CONFIGURED before anything is written.
//
// The web tier does not seal or open sessions -- it reaches the durable worker, which does. This
// module binds the enabled providers to the SourceConnectionService, and exposes the signed worker
// client the connect flow uses.

import 'server-only';

import { SourceConnectionService, prisma, repositories } from '@emgloop/database';

import { readConnectionEnvironment, type ConnectionWorkerEndpoint } from './connection-environment';

/** The connection lifecycle for a signed-in person. The principal is always the session's. */
export function sourceConnections(): SourceConnectionService {
  const env = readConnectionEnvironment();
  return new SourceConnectionService(prisma, {
    configured: env.state === 'CONFIGURED' ? { providers: env.providers } : null,
    authorize: (principal, action) =>
      repositories.iam.can({ organizationId: principal.organizationId, userId: principal.userId, resource: 'sourceConnections', action }),
  });
}

/** The worker endpoint (URL + control secret) when configured, else null. Server-only. */
export function connectionsWorkerEndpoint(): ConnectionWorkerEndpoint | null {
  const env = readConnectionEnvironment();
  return env.state === 'CONFIGURED' ? env.worker : null;
}
