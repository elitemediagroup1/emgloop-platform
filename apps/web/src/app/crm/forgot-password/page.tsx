// CRM Forgot Password. Requests a password reset. The reset link is delivered
// only by email to the account's own address; this page never receives, reads
// or renders a token, and shows the same confirmation whether or not an account
// exists.

import Link from 'next/link';
import { requestResetAction } from '../../../auth/actions';

export const dynamic = 'force-dynamic';

export default function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: { sent?: string };
}) {
  const sent = Boolean(searchParams.sent);
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
