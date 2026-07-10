import Link from 'next/link';
import { repositories } from '@emgloop/database';
import { hashToken } from '../../../auth/auth';
import { acceptInviteAction } from '../../../auth/actions';

export const dynamic = 'force-dynamic';

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  EMPLOYEE: 'Employee',
  AI_EMPLOYEE: 'AI Employee',
  READ_ONLY: 'Read Only',
};

type InviteState =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | {
      kind: 'valid';
      token: string;
      email: string;
      organizationName: string | null;
      roleLabel: string | null;
    };

async function resolveInvite(rawToken: string | undefined): Promise<InviteState> {
  const token = (rawToken ?? '').trim();
  if (!token) {
    return { kind: 'missing' };
  }

  const { iam, organizations } = await repositories();

  // Never trust client-provided email/org/role. Everything is derived from the
  // token server-side. findInvitationByToken only returns PENDING invitations,
  // so revoked / already-accepted links resolve to "invalid".
  const invitation = await iam.findInvitationByToken(hashToken(token));
  if (!invitation) {
    return { kind: 'invalid' };
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    return { kind: 'expired' };
  }

  let organizationName: string | null = null;
  try {
    const org = await organizations.findById(invitation.organizationId);
    organizationName = org?.name ?? null;
  } catch {
    organizationName = null;
  }

  return {
    kind: 'valid',
    token,
    email: invitation.email,
    organizationName,
    roleLabel: ROLE_LABELS[invitation.systemRole] ?? invitation.systemRole ?? null,
  };
}

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: { token?: string; error?: string };
}) {
  const state = await resolveInvite(searchParams.token);
  const error = searchParams.error;

  if (state.kind === 'missing' || state.kind === 'invalid') {
    return (
      <div className="crm-auth-wrap">
        <div className="crm-auth-card">
          <h1>Invitation link not valid</h1>
          <p className="crm-auth-sub">
            This invitation link is invalid or is no longer active. Please ask an
            administrator to send you a new invitation.
          </p>
          <div className="crm-auth-links">
            <Link href="/crm/login">Go to sign in</Link>
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === 'expired') {
    return (
      <div className="crm-auth-wrap">
        <div className="crm-auth-card">
          <h1>This invitation has expired</h1>
          <p className="crm-auth-sub">
            For security, invitation links expire after a set period. Please ask an
            administrator to send you a new invitation.
          </p>
          <div className="crm-auth-links">
            <Link href="/crm/login">Go to sign in</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="crm-auth-wrap">
      <div className="crm-auth-card">
        <h1>Join EMG Loop</h1>
        <p className="crm-auth-sub">
          You have been invited to
          {state.organizationName ? ' ' + state.organizationName : ' EMG Loop'}
          {state.roleLabel ? ' as ' + state.roleLabel : ''}. Create your account to
          get started.
        </p>

        {error ? <div className="crm-auth-error">{error}</div> : null}

        <div className="crm-auth-hint">
          Invited email: <strong>{state.email}</strong>
        </div>

        <form action={acceptInviteAction}>
          <input type="hidden" name="token" value={state.token} />

          <div className="crm-field">
            <label htmlFor="name">Full name</label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              required
              className="crm-input"
            />
          </div>

          <div className="crm-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              className="crm-input"
            />
          </div>

          <div className="crm-field">
            <label htmlFor="confirm">Confirm password</label>
            <input
              id="confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              className="crm-input"
            />
          </div>

          <button type="submit" className="crm-btn-primary">
            Create account and join EMG Loop
          </button>
        </form>

        <div className="crm-auth-links">
          <Link href="/crm/login">Already have an account? Sign in</Link>
        </div>
      </div>
    </div>
  );
}
