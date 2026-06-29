import { EMG_LOOP_SDK_SOURCE, EMG_LOOP_SDK_VERSION } from '../../../sdk/sdk-source';

// GET /api/sdk/emg-loop - serves the real EMG Loop browser SDK (Sprint 17).
//
// The public URL is /sdk/emg-loop.js (a Next.js rewrite in next.config.mjs maps
// it here). A route segment containing a dot ('emg-loop.js') is treated by the
// Next/Netlify runtime as a static file request and 404s, so the handler lives
// at this dotless path and the rewrite gives sites the familiar .js URL.
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
