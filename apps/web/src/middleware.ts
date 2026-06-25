// Edge middleware — Sprint 7 (Identity, Authentication & Organizations).
//
// A lightweight authentication gate for the CRM. It only checks for the
// PRESENCE of the session cookie (Edge runtime has no DB / Node crypto); the
// real session resolution + permission checks happen server-side in the page
// guards. Unauthenticated requests to a protected /crm route are redirected to
// the login page with a ?next param. The auth screens are always public.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE = 'emgloop_session';

const PUBLIC_PATHS = [
  '/crm/login',
  '/crm/forgot-password',
  '/crm/reset-password',
  '/crm/unauthorized',
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!pathname.startsWith('/crm')) return NextResponse.next();
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  if (hasSession) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/crm/login';
  url.search = '?next=' + encodeURIComponent(pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/crm/:path*'],
};
