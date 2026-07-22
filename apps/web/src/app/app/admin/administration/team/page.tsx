// Administration › Team — user & invitation management, inside the approved
// EMG Loop application shell (the ADMIN layout renders WorkspaceShell around this).
//
// This is the canonical home of team/user management. It reuses the EXACT same
// org-scoped server actions the old /crm/users page used (invite, role, status,
// remove) — the feature is unchanged; only its route ownership and shell moved
// out of the legacy CRM sidebar. /crm/users now redirects here.

import { requirePermission, hasPermission } from '../../../../../auth/guard';
import { repositories } from '@emgloop/database';
import { SYSTEM_ROLES, SYSTEM_ROLE_LABELS } from '@emgloop/database';
import {
  inviteUserAction,
  setUserRoleAction,
  setUserStatusAction,
  removeUserAction,
} from '../../../../../crm/admin-actions';

export const dynamic = 'force-dynamic';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default async function AdminTeamPage() {
  const session = await requirePermission('users', 'view');
  const canManage = await hasPermission('users', 'create');
  const users = await repositories.iam.listUsers(session.organizationId);
  const invites = await repositories.iam.listInvitations(session.organizationId);

  return (
    <div className="adm">
      <div className="loop-pagehead">
        <div className="loop-eyebrow">Administration</div>
        <h1 className="loop-title">Team</h1>
        <p className="loop-subtitle">
          {users.length} team member{users.length === 1 ? '' : 's'} · {invites.length} pending invitation{invites.length === 1 ? '' : 's'}
        </p>
      </div>

      {canManage ? (
        <section className="adm-card">
          <h2 className="adm-card__title">Invite a team member</h2>
          <form action={inviteUserAction} className="adm-inviteform">
            <label className="adm-field">
              <span className="adm-field__label">Name</span>
              <input className="adm-input" name="name" placeholder="Full name" />
            </label>
            <label className="adm-field">
              <span className="adm-field__label">Email</span>
              <input className="adm-input" type="email" name="email" placeholder="name@company.com" required />
            </label>
            <label className="adm-field">
              <span className="adm-field__label">Role</span>
              <select className="adm-input" name="role" defaultValue="EMPLOYEE">
                {SYSTEM_ROLES.map((r) => (
                  <option key={r} value={r}>{SYSTEM_ROLE_LABELS[r]}</option>
                ))}
              </select>
            </label>
            <button className="adm-btn adm-btn--primary" type="submit">Send invite</button>
          </form>
        </section>
      ) : null}

      <section className="adm-card">
        <h2 className="adm-card__title">Team members</h2>
        <div className="adm-tablewrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Name</th><th>Email</th><th>Role</th><th>Status</th>
                <th>Last sign-in</th><th>Added</th>{canManage ? <th>Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td className="adm-faint">{u.email}</td>
                  <td>
                    {canManage ? (
                      <form action={setUserRoleAction} className="adm-inline">
                        <input type="hidden" name="userId" value={u.id} />
                        <select className="adm-input adm-input--sm" name="role" defaultValue={u.systemRole}>
                          {SYSTEM_ROLES.map((r) => (
                            <option key={r} value={r}>{SYSTEM_ROLE_LABELS[r]}</option>
                          ))}
                        </select>
                        <button className="adm-btn" type="submit">Save</button>
                      </form>
                    ) : (
                      <span className="adm-badge">{u.roleLabel}</span>
                    )}
                  </td>
                  <td>
                    <span className={'adm-badge adm-badge--' + (u.status === 'ACTIVE' ? 'ok' : u.status === 'DISABLED' ? 'warn' : 'off')}>
                      {u.status === 'ACTIVE' ? 'Active' : u.status === 'DISABLED' ? 'Disabled' : u.status}
                    </span>
                  </td>
                  <td className="adm-faint">{fmtDate(u.lastLoginAt)}</td>
                  <td className="adm-faint">{fmtDate(u.createdAt)}</td>
                  {canManage ? (
                    <td>
                      <div className="adm-inline">
                        {u.status === 'DISABLED' ? (
                          <form action={setUserStatusAction}>
                            <input type="hidden" name="userId" value={u.id} />
                            <input type="hidden" name="status" value="ACTIVE" />
                            <button className="adm-btn" type="submit">Reactivate</button>
                          </form>
                        ) : (
                          <form action={setUserStatusAction}>
                            <input type="hidden" name="userId" value={u.id} />
                            <input type="hidden" name="status" value="DISABLED" />
                            <button className="adm-btn" type="submit" disabled={u.id === session.userId}>Disable</button>
                          </form>
                        )}
                        <form action={removeUserAction}>
                          <input type="hidden" name="userId" value={u.id} />
                          <button className="adm-btn adm-btn--danger" type="submit" disabled={u.id === session.userId}>Remove</button>
                        </form>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="adm-card">
        <h2 className="adm-card__title">Pending invitations</h2>
        {invites.length === 0 ? (
          <p className="adm-empty">No pending invitations. Invited people appear here until they accept.</p>
        ) : (
          <div className="adm-tablewrap">
            <table className="adm-table">
              <thead><tr><th>Email</th><th>Role</th><th>Invited</th></tr></thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td><span className="adm-badge">{SYSTEM_ROLE_LABELS[i.systemRole]}</span></td>
                    <td className="adm-faint">{fmtDate(i.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
