// CRM Reset Password — Sprint 7. Consumes a reset token and sets a new
// password (scrypt hash). Invalidates all existing sessions for the user.

import Link from 'next/link';
import { resetPasswordAction } from '../../../auth/actions';

export const dynamic = 'force-dynamic';

export default function ResetPasswordPage({
  searchParams,
}: {
  searchParams: { token?: string; error?: string };
}) {
  const token = searchParams.token ?? '';
  return (
    <div className="crm-auth-wrap">
      <div className="crm-auth-card">
        <h1>Set a new password</h1>
        <p className="crm-auth-sub">Choose a strong password (at least 8 characters).</p>
        {searchParams.error ? (
          <div className="crm-auth-error">{searchParams.error}</div>
        ) : null}
        {!token ? (
          <div className="crm-auth-error">Missing or invalid reset link.</div>
        ) : (
          <form action={resetPasswordAction}>
            <input type="hidden" name="token" value={token} />
            <label className="crm-field">
              <span>New password</span>
              <input className="crm-input" type="password" name="password" autoComplete="new-password" required />
            </label>
            <label className="crm-field">
              <span>Confirm password</span>
              <input className="crm-input" type="password" name="confirm" autoComplete="new-password" required />
            </label>
            <button className="crm-btn-primary" type="submit">Update password</button>
          </form>
        )}
        <div className="crm-auth-links">
          <Link href="/crm/login">Back to sign in</Link>
          <span />
        </div>
      </div>
    </div>
  );
}
