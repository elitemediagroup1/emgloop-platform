// The ONE canonical server-side application origin.
//
// Emails, invitations, password resets, notifications — anything generated on the
// server that a human clicks later — MUST build an absolute URL from this origin.
// A relative path (e.g. "/crm/accept-invite?token=…") is a production bug: an
// email client resolves it against its own host and produces "http:///crm/…".
//
// Never use the browser origin or a request Host header here (server-side email
// generation has no trustworthy request origin, and a spoofable Host would let an
// attacker mint links to their own domain). Never hardcode localhost or a deploy
// preview. The origin comes from configuration, and falls back to the known
// production domain so we can NEVER emit a relative URL.

// The production application origin. Mirrors PLATFORM.appUrl (@emgloop/shared).
const CANONICAL_APP_ORIGIN = 'https://app.emgloop.com';

/**
 * The absolute application origin (scheme + host, no trailing slash).
 *
 * Resolution order:
 *   1. APP_URL                (preferred; set per environment)
 *   2. NEXT_PUBLIC_APP_URL     (existing legacy variable, kept for compatibility)
 *   3. the canonical production origin (so we fail CLOSED to a valid absolute
 *      URL, never to a broken relative one)
 *
 * In development set APP_URL=http://localhost:3000; in a deploy preview set
 * APP_URL to the preview origin ONLY when test invitations are safe there.
 */
export function appOrigin(): string {
  const configured = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || '').trim();
  const origin = configured || CANONICAL_APP_ORIGIN;
  return origin.replace(/\/+$/, ''); // normalize: strip any trailing slash(es)
}

/** Join a path onto the canonical origin, producing an absolute URL. */
export function absoluteAppUrl(path: string): string {
  const p = path.startsWith('/') ? path : '/' + path;
  return appOrigin() + p;
}

// The canonical invitation-acceptance route. Defined ONCE so every generator
// (email HTML, email text, resend, any copied link) uses the same path — change
// it here and every invitation URL follows.
export const INVITATION_ACCEPT_PATH = '/crm/accept-invite';

/** The absolute invitation-acceptance URL for a token. */
export function invitationAcceptUrl(token: string): string {
  return absoluteAppUrl(`${INVITATION_ACCEPT_PATH}?token=${encodeURIComponent(token)}`);
}

// The canonical password-reset route.
export const PASSWORD_RESET_PATH = '/crm/reset-password';

/** The absolute password-reset URL for a token. */
export function passwordResetUrl(token: string): string {
  return absoluteAppUrl(`${PASSWORD_RESET_PATH}?token=${encodeURIComponent(token)}`);
}
