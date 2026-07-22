// Auth core — Sprint 7 (Identity, Authentication & Organizations).
//
// Server-only authentication primitives for the CRM. Email/password only — no
// social logins yet. Uses Node's built-in crypto so the platform adds zero new
// dependencies:
//   - Password hashing: scrypt with a per-user random salt (stored as
//     scrypt$<saltHex>$<hashHex>).
//   - Session token: a random opaque secret stored in an httpOnly cookie; only
//     its SHA-256 hash is persisted (UserSession.tokenHash), so a DB leak never
//     exposes a usable session.
//   - Password-reset token: same hash-at-rest pattern (PasswordReset.tokenHash).
//
// All persistence goes through the @emgloop/database repository layer.

import 'server-only';
import { cookies } from 'next/headers';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'crypto';
import { repositories, type User } from '@emgloop/database';
import {
  userSystemRole,
  roleLabel,
  type Resource,
  type Action,
} from '@emgloop/database';

export const SESSION_COOKIE = 'emgloop_session';
const REMEMBER_DAYS = 30;
const SESSION_DAYS = 1;

// --- Password hashing --------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    const scheme = parts[0];
    const saltHex = parts[1];
    const hashHex = parts[2];
    if (parts.length !== 3 || scheme !== 'scrypt' || !saltHex || !hashHex) {
      return false;
    }
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// --- Tokens ------------------------------------------------------------

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// --- Session shape exposed to the app ----------------------------------

export interface AuthSession {
  userId: string;
  organizationId: string;
  email: string;
  name: string;
  systemRole: string;
  roleLabel: string;
}

function toAuthSession(user: User): AuthSession {
  const role = userSystemRole(user);
  return {
    userId: user.id,
    organizationId: user.organizationId,
    email: user.email,
    name: user.name ?? user.email,
    systemRole: role,
    roleLabel: roleLabel(role),
  };
}

// --- Login / logout ----------------------------------------------------

export interface LoginResult {
  ok: boolean;
  error?: string;
}

/** Verify credentials, create a session row, and set the session cookie. */
export async function login(args: {
  email: string;
  password: string;
  remember?: boolean;
}): Promise<LoginResult> {
  const email = args.email.toLowerCase().trim();
  if (!email || !args.password) return { ok: false, error: 'Email and password are required.' };

  const user = await repositories.auth.findAnyUserByEmail(email);
  if (!user) return { ok: false, error: 'Invalid email or password.' };
  // Only fully-onboarded members may sign in. Fail closed on any non-ACTIVE
  // status: DISABLED = access revoked (removed or disabled); INVITED = the
  // invitation has not been accepted yet. A re-invited teammate keeps their old
  // row (now INVITED) so this is what stops a stale password from logging them
  // back in before they accept the fresh link. Keep the disabled-specific message
  // but stay generic for INVITED so we don't reveal a pending invitation exists.
  if (user.status !== 'ACTIVE') {
    return {
      ok: false,
      error: user.status === 'DISABLED'
        ? 'This account has been disabled.'
        : 'Invalid email or password.',
    };
  }

  const stored = await repositories.auth.getPasswordHash(user.id);
  if (!stored || !verifyPassword(args.password, stored)) {
    return { ok: false, error: 'Invalid email or password.' };
  }

  const token = newToken();
  const days = args.remember ? REMEMBER_DAYS : SESSION_DAYS;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  await repositories.auth.createSession({
    organizationId: user.organizationId,
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  await repositories.auth.recordLogin(user.id);

  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
  return { ok: true };
}

export async function logout(): Promise<void> {
  const jar = cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await repositories.auth.revokeSession(hashToken(token));
  }
  jar.set(SESSION_COOKIE, '', { path: '/', expires: new Date(0) });
}

// --- Reading the current session ---------------------------------------

/** Resolve the current session from the cookie, or null if unauthenticated. */
export async function getSession(): Promise<AuthSession | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const resolved = await repositories.auth.resolveSession(hashToken(token));
  if (!resolved) return null;
  return toAuthSession(resolved.user);
}

/** Permission check for the current session. */
export async function can(resource: Resource, action: Action): Promise<boolean> {
  const session = await getSession();
  if (!session) return false;
  return repositories.iam.can({
    organizationId: session.organizationId,
    userId: session.userId,
    resource,
    action,
  });
}
