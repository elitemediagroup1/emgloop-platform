// The ONE module in the web application that reads the creator-media storage environment.
// SERVER ONLY, fenced like connection-environment.ts.
//
// OFF UNTIL CONFIGURED, HONESTLY. With nothing set, `mediaStorage()` is null and every upload
// is refused before a row is written. Two configurations exist:
//   LOOP_MEDIA_STORAGE=aws    the staging media signer inside the connections stack, reached at
//                             `<connections worker URL>/media/sign` and signed with the worker
//                             control secret both sides already hold (connection-environment.ts
//                             is the one module that reads those names). No AWS credential and
//                             no AWS SDK in this tier.
//   LOOP_MEDIA_STORAGE=local  a dev-only disk directory behind /api/creator/media/local, for a
//                             developer's machine. Refused outright on a production runtime.

import 'server-only';

import { LocalMediaStorage, SignerMediaStorage, type MediaObjectStorage } from '@emgloop/providers';
import { readConnectionWorkerEndpoint } from '../connections/connection-environment';
import { isProductionRuntime } from '../crm/webhook-runtime';

export const MEDIA_ENVIRONMENT = Object.freeze({
  storage: 'LOOP_MEDIA_STORAGE',
  localDir: 'LOOP_MEDIA_LOCAL_DIR',
  localSecret: 'LOOP_MEDIA_LOCAL_SECRET',
} as const);

export const LOCAL_MEDIA_ROUTE = '/api/creator/media/local';

export type MediaRuntime =
  | { readonly state: 'NOT_CONFIGURED'; readonly reason: string }
  | { readonly state: 'CONFIGURED'; readonly storage: MediaObjectStorage };

export function readMediaRuntime(source: Partial<Record<string, string | undefined>> = process.env, host?: string | null): MediaRuntime {
  const mode = (source[MEDIA_ENVIRONMENT.storage] ?? '').trim().toLowerCase();
  if (mode === 'aws') {
    const worker = readConnectionWorkerEndpoint(source);
    if (!worker) return { state: 'NOT_CONFIGURED', reason: 'The media signer needs the connections worker URL and control secret.' };
    return { state: 'CONFIGURED', storage: new SignerMediaStorage({ signerUrl: `${worker.url}/media/sign`, secret: worker.secret }) };
  }
  if (mode === 'local') {
    if (isProductionRuntime(host)) return { state: 'NOT_CONFIGURED', reason: 'Local media storage is never used in production.' };
    const directory = (source[MEDIA_ENVIRONMENT.localDir] ?? '').trim();
    const secret = (source[MEDIA_ENVIRONMENT.localSecret] ?? '').trim();
    if (!directory || !secret) return { state: 'NOT_CONFIGURED', reason: 'Local media storage needs a directory and a secret.' };
    return { state: 'CONFIGURED', storage: new LocalMediaStorage({ directory, routePath: LOCAL_MEDIA_ROUTE, secret }) };
  }
  return { state: 'NOT_CONFIGURED', reason: 'Media storage is not configured for this deployment.' };
}

/** The storage for this request, or null when uploads are unavailable. */
export function mediaStorage(host?: string | null): MediaObjectStorage | null {
  const runtime = readMediaRuntime(process.env, host);
  return runtime.state === 'CONFIGURED' ? runtime.storage : null;
}
