// Edge middleware — Sprint 7 (Identity, Authentication & Organizations).
//
// A lightweight authentication gate for the CRM. It only checks for the
// PRESENCE of the session cookie (Edge runtime has no DB / Node crypto); the
// real session resolution + permission checks happen server-side in the page
// guards. Unauthenticated requests to a protected /crm route are redirected to
// the login page with a ?next param. The auth screens are always public.
//
// Sprint 17.1 (UX): additionally forwards an x-pathname request header so the
// CRM layout can render public auth screens (login, forgot/reset password,
// accept-invite, unauthorized) as standalone pages without the app shell.
// This is presentation-only plumbing — the auth gate / redirect logic below
// is UNCHANGED.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE = 'emgloop_session';

// Public auth screens. These must stay in sync with STANDALONE_PREFIXES in
// apps/web/src/app/crm/layout.tsx, which renders exactly these paths without
// the authenticated app shell. /crm/accept-invite is public by design: the
// invitee has no account yet, so the page derives everything from the signed
// invitation token server-side and never reads a session.
const PUBLIC_PATHS = [
  '/crm/login',
  '/crm/forgot-password',
  '/crm/reset-password',
  '/crm/accept-invite',
  '/crm/unauthorized',
];

function withPathname(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set('x-pathname', req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Team/user management moved to Administration. Redirect the legacy CRM route
  // at the EDGE — before the CRM layout or any server code runs — so its
  // production server exception can never occur on the onboarding journey.
  if (pathname === '/crm/users' || pathname.startsWith('/crm/users/')) {
    const url = req.nextUrl.clone();
    url.pathname = '/app/admin/administration/team';
    url.search = '';
    return NextResponse.redirect(url);
  }

  if (!pathname.startsWith('/crm')) return withPathname(req);
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return withPathname(req);
  }
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  if (hasSession) return withPathname(req);
  const url = req.nextUrl.clone();
  url.pathname = '/crm/login';
  url.search = '?next=' + encodeURIComponent(pathname);
  return NextResponse.redirect(url);
}

// Sprint 29B: /app is matched so the x-pathname header reaches the shared
// WorkspaceShell there too — its breadcrumb resolves from the current path, and
// one breadcrumb system means one source for that path.
//
// This is header plumbing ONLY. The auth gate above is unchanged and still
// applies exclusively to /crm: the first line of middleware() returns early for
// any non-/crm path, so /app remains ungated at the edge and continues to rely
// on requireWorkspace() in its layouts. No route gains or loses protection.
export const config = {
  matcher: ['/crm/:path*', '/app/:path*'],
};
