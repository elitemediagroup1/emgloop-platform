// CRM Login — Sprint 7 (Identity, Authentication & Organizations).
// Sprint 13: brand-forward presentation (EMG Loop wordmark + Elite Media Group
// mark). Auth logic, action, session and redirect below are UNCHANGED.
//
// Email/password sign-in for the operations console. Renders the demo seed
// credentials so reviewers can sign in (no email delivery yet). On submit, the
// loginAction verifies the password (scrypt) and sets the session cookie.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loginAction } from '../../../auth/actions';
import { getSession } from '../../../auth/auth';
import { ensureCrmIdentity, DEMO_OWNER_EMAIL, DEMO_DEFAULT_PASSWORD } from '../../../auth/bootstrap';
import { EmgLoopWordmark, EliteMediaGroupMark } from '../_brand/Logos';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; reset?: string; next?: string };
}) {
  await ensureCrmIdentity();
  const session = await getSession();
  if (session) redirect('/crm');

  return (
    <div className="crm-auth-wrap">
      <div className="crm-auth-card">
        <div style={{ marginBottom: '1rem' }}>
          <EmgLoopWordmark height={30} />
        </div>
        <h1>Sign in</h1>
        <p className="crm-auth-sub">Your business operating system</p>
        {searchParams.error ? (
          <div className="crm-auth-error">{searchParams.error}</div>
        ) : null}
        {searchParams.reset ? (
          <div className="crm-auth-ok">Password updated. Sign in with your new password.</div>
        ) : null}
        <form action={loginAction}>
          <label className="crm-field">
            <span>Email</span>
            <input className="crm-input" type="email" name="email" autoComplete="email" required />
          </label>
          <label className="crm-field">
            <span>Password</span>
            <input className="crm-input" type="password" name="password" autoComplete="current-password" required />
          </label>
          <label className="crm-checkrow">
            <input type="checkbox" name="remember" value="1" /> Remember me for 30 days
          </label>
          <button className="crm-btn-primary" type="submit">Sign in</button>
        </form>
        <div className="crm-auth-links">
          <Link href="/crm/forgot-password">Forgot password?</Link>
          <Link href="/dashboard">Back to dashboard</Link>
        </div>
        <div className="crm-auth-hint">
          Demo sign-in: <code>{DEMO_OWNER_EMAIL}</code> / <code>{DEMO_DEFAULT_PASSWORD}</code>
          <br />Manager: <code>manager@emgloop.com</code> · Read-only: <code>viewer@emgloop.com</code> (same password)
        </div>
        <div style={{ marginTop: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: 0.7 }}>
          <EliteMediaGroupMark height={16} />
        </div>
      </div>
    </div>
  );
}
