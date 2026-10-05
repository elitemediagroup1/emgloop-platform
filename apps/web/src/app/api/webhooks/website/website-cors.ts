// CORS for the website webhook's BROWSER tier (2026-10-05).
//
// WHY. The EMG Loop tracker runs on each property's own domain (servicesinmycity.com, ...) and POSTs to Loop's
// domain with `Content-Type: application/json` and an `X-EMG-Ingest-Key` header. Both make the request
// "non-simple", so every browser first sends an OPTIONS preflight and sends the POST only if the preflight answers
// with Access-Control-Allow-* headers. Until 2026-10-05 the endpoint answered the preflight with a bare 204 and no
// CORS headers (verified against production): every browser blocked every tracker POST before it was sent, on
// every property, which alone explains a production website-event count of zero. The POST response needs the
// header too, or `fetch` rejects a response the server already stored and the tracker retries it.
//
// WHAT IT GRANTS -- nothing beyond what the request already had. `*` with no credentials (the tracker sends
// `credentials: 'omit'`) lets any page's script SEND a request and read the JSON reply. It authorizes nothing:
// admission still requires a registered LIVE + ENABLED property, and in production the request's Origin -- which a
// browser sets and page script cannot -- must be one of that property's registered domains. The signed
// server-to-server tier never needed CORS and is unaffected.

export const WEBSITE_INGEST_CORS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-EMG-Ingest-Key',
  'Access-Control-Max-Age': '86400',
});

/** The same response, carrying the browser-tier CORS headers. */
export function withWebsiteIngestCors(res: Response): Response {
  for (const [k, v] of Object.entries(WEBSITE_INGEST_CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

/** The preflight answer: no body, the allowed method and headers, cached for a day. */
export function websiteIngestPreflight(): Response {
  return withWebsiteIngestCors(new Response(null, { status: 204 }));
}
