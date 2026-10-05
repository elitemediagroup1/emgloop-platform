import { EMG_LOOP_SDK_SOURCE, EMG_LOOP_SDK_VERSION } from '../../../sdk/sdk-source';

// GET /api/sdk/emg-loop - serves the real EMG Loop browser SDK (Sprint 17).
//
// Sites load the STATIC copy, apps/web/public/sdk/emg-loop.js, at /sdk/emg-loop.js -- there is no rewrite to this
// route (next.config.mjs). This route serves the same source (sdk-source.ts) for programmatic consumers. The two
// copies are kept behaviorally identical by hand; the static file is the one browsers run.
//
// The SDK is plain, dependency-free browser JavaScript returned verbatim with a
// JavaScript content type and long-lived caching. No secrets, no per-request
// state - the same asset for every site.

export const dynamic = 'force-static';
export const revalidate = 3600;

export function GET(): Response {
  return new Response(EMG_LOOP_SDK_SOURCE, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
      'X-EMG-Loop-SDK-Version': EMG_LOOP_SDK_VERSION,
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
    },
  });
}
