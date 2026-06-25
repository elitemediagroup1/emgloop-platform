// CRM Forgot Password — Sprint 7. Requests a password-reset token. Because
// email delivery is out of scope, on success the reset link is displayed
// in-app (via the ?token query param) so reviewers can complete the flow.

import Link from 'next/link';
import { requestResetAction } from '../../../auth/actions';

export const dynamic = 'force-dynamic';

export default function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: { sent?: string; token?: string };
}) {
  const sent = Boolean(searchParams.sent);
  const token = searchParams.token;
  return (
    <div className="crm-auth-wrap">
      <div className="crm-auth-card">
        <h1>Reset your password</h1>
        <p className="crm-auth-sub">Enter your account email to get a reset link.</p>
        {sent ? (
          <div className="crm-auth-ok">
            If an account exists for that email, a reset link has been generated.
          </div>
        ) : null}
        {token ? (
          <div className="crm-auth-hint">
            No email service is configured in this environment, so here is your
            one-time reset link:{' '}
            <Link href={'/crm/reset-password?token=' + token}>Set a new password</Link>
          </div>
        ) : null}
        {!sent ? (
          <form action={requestResetAction}>
            <label className="crm-field">
              <span>Email</span>
              <input className="crm-input" type="email" name="email" autoComplete="email" required />
            </label>
            <button className="crm-btn-primary" type="submit">Send reset link</button>
          </form>
        ) : null}
        <div className="crm-auth-links">
          <Link href="/crm/login">Back to sign in</Link>
          <span />
        </div>
      </div>
    </div>
  );
}
