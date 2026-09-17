// Where a person lands after signing in, and which requested destinations are
// allowed to survive sign-in.
//
// ONE AUTHORITY. Every sign-in path (the login action, the login page for an
// already signed-in visitor, the root entry, and the session guards) decides its
// destination here, so they cannot drift apart again.
//
// LOOP HOME IS THE DEFAULT. A normal sign-in goes to /app. A requested deep link
// survives only if it is a same-origin path into the authenticated application
// (/app or /crm today) and is not itself an authentication screen. Anything else
// falls back to /app. Surviving here grants nothing: the destination page still
// enforces its own authorization on arrival.

export const LOOP_HOME = '/app';
export const LOGIN_PATH = '/crm/login';

/**
 * Where a person lands right after accepting an invitation: employee onboarding, which
 * asks them to connect their own Google Workspace (optional) and then continues to Loop
 * Home. A normal sign-in never goes here.
 */
export const ONBOARDING_GOOGLE_PATH = '/app/onboarding/google';

/** A person's own connections, reachable at any time after onboarding. */
export const CONNECTIONS_PATH = '/app/connections';

/** The destination after an invitation is accepted and the session is established. */
export function postInvitationDestination(): string {
  return ONBOARDING_GOOGLE_PATH;
}

/** Authentication screens: never a post-login destination (it would loop). */
export const AUTH_SCREENS: readonly string[] = [
  '/crm/login',
  '/crm/forgot-password',
  '/crm/reset-password',
  '/crm/accept-invite',
  '/crm/unauthorized',
];

/** Trees a deep link may point into. Module URLs move under /app in later PRs. */
const APPLICATION_PREFIXES: readonly string[] = ['/app', '/crm'];

// Only used to parse and normalise a relative path; never part of any output.
const PARSE_BASE = 'https://loop.invalid';
const MAX_LENGTH = 2048;

const within = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(prefix + '/');

/**
 * The requested destination, normalised, if it is safe to send a signed-in
 * person there; otherwise null.
 */
export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const candidate = raw.trim();
  if (!candidate || candidate.length > MAX_LENGTH) return null;
  // A path, not a URL: no scheme, no protocol-relative host, no backslash tricks,
  // no control characters or raw whitespace.
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return null;
  if (/[\\\u0000-\u001f\u007f\s]/.test(candidate)) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return null;
  }
  if (decoded.startsWith('//') || decoded.includes('\\')) return null;

  let url: URL;
  try {
    url = new URL(candidate, PARSE_BASE);
  } catch {
    return null;
  }
  if (url.origin !== PARSE_BASE) return null;
  // Checked after normalisation, so /app/../api cannot slip through.
  if (!APPLICATION_PREFIXES.some((p) => within(url.pathname, p))) return null;
  if (AUTH_SCREENS.some((p) => within(url.pathname, p))) return null;

  return url.pathname + url.search + url.hash;
}

/** Where to send a person who has just signed in (or already is). */
export function postLoginDestination(requestedNext: unknown): string {
  return safeNextPath(requestedNext) ?? LOOP_HOME;
}

/** The login screen, carrying a requested destination only when it is safe. */
export function loginPathFor(requestedNext?: unknown, extra?: Record<string, string>): string {
  const params = new URLSearchParams(extra);
  const next = safeNextPath(requestedNext);
  if (next) params.set('next', next);
  const query = params.toString();
  return query ? `${LOGIN_PATH}?${query}` : LOGIN_PATH;
}
