import 'server-only';
import type { TikTokBusinessKind } from '@emgloop/providers';
import { BUSINESS_SETTINGS, businessPrincipal, businessService } from './runtime';
export async function businessCallback(request: Request, kind: TikTokBusinessKind): Promise<Response> {
  let outcome = 'STATE_INVALID';
  try {
    const url = new URL(request.url);
    const p = await businessPrincipal();
    if (p) outcome = await businessService(kind).complete(p, kind, {
      state: url.searchParams.getAll('state').length === 1 ? url.searchParams.get('state') : null,
      authCode: url.searchParams.getAll('auth_code').length === 1 ? url.searchParams.get('auth_code') : null,
      error: url.searchParams.get('error') || url.searchParams.get('error_code'),
    });
  } catch { outcome = 'FAILED'; }
  return new Response(null, { status: 303, headers: { location: `${BUSINESS_SETTINGS}?outcome=${outcome}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}
