// CRM Users — Sprint 7 (Identity, Authentication & Organizations).
//
// Full user management for the current organization: list with name, email,
// role, status, last login and created date; invite a new user; change a
// user's role; disable / reactivate / remove. Protected by the IAM resolver
// (requires users:view). Mutating controls are only rendered when the viewer
// can manage users. All data is read from Neon via the repository layer.

import { requirePermission, hasPermission } from '../../../auth/guard';
import { repositories } from '@emgloop/database';
import { SYSTEM_ROLES, SYSTEM_ROLE_LABELS } from '@emgloop/database';
import {
  inviteUserAction,
  setUserRoleAction,
  setUserStatusAction,
  removeUserAction,
} from '../../../crm/admin-actions';

export const dynamic = 'force-dynamic';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default async function UsersPage() {
  const session = await requirePermission('users', 'view');
  const canManage = await hasPermission('users', 'create');
  const users = await repositories.iam.listUsers(session.organizationId);
  const invites = await repositories.iam.listInvitations(session.organizationId);

  return (
    <div className="crm-page">
      <div className="crm-page-head">
        <div>
          <h1>Users</h1>
          <p>{users.length} team members · {invites.length} pending invitation(s)</p>
        </div>
      </div>

      {canManage ? (
        <div className="crm-card" style={{ marginBottom: 18 }}>
          <h3>Invite a user</h3>
          <form action={inviteUserAction} className="crm-form-grid" style={{ marginTop: 10 }}>
            <label className="crm-field"><span>Name</span>
              <input className="crm-input" name="name" placeholder="Full name" /></label>
            <label className="crm-field"><span>Email</span>
              <input className="crm-input" type="email" name="email" required /></label>
            <label className="crm-field"><span>Role</span>
              <select className="crm-select" name="role" defaultValue="EMPLOYEE">
                {SYSTEM_ROLES.map((r) => (
                  <option key={r} value={r}>{SYSTEM_ROLE_LABELS[r]}</option>
                ))}
              </select></label>
            <div className="crm-field" style={{ display:'flex', alignItems:'flex-end' }}>
              <button className="crm-btn-primary" type="submit" style={{ width: 'auto', padding: '9px 16px' }}>Send invite</button>
            </div>
          </form>
        </div>
      ) : null}

      <table className="crm-table">
        <thead>
          <tr>
            <th>Name</th><th>Email</th><th>Role</th><th>Status</th>
            <th>Last login</th><th>Created</th>{canManage ? <th>Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td className="crm-faint">{u.email}</td>
              <td>
                {canManage ? (
                  <form action={setUserRoleAction} className="crm-inline-actions">
                    <input type="hidden" name="userId" value={u.id} />
                    <select className="crm-select" name="role" defaultValue={u.systemRole} style={{ width: 'auto' }}>
                      {SYSTEM_ROLES.map((r) => (
                        <option key={r} value={r}>{SYSTEM_ROLE_LABELS[r]}</option>
                      ))}
                    </select>
                    <button className="crm-btn-sm" type="submit">Save</button>
                  </form>
                ) : (
                  <span className="crm-badge role">{u.roleLabel}</span>
                )}
              </td>
              <td>
                <span className={'crm-badge ' + (u.status === 'ACTIVE' ? 'ok' : u.status === 'DISABLED' ? 'warn' : 'off')}>
                  {u.status}
                </span>
              </td>
              <td className="crm-faint">{fmtDate(u.lastLoginAt)}</td>
              <td className="crm-faint">{fmtDate(u.createdAt)}</td>
              {canManage ? (
                <td>
                  <div className="crm-inline-actions">
                    {u.status === 'DISABLED' ? (
                      <form action={setUserStatusAction}>
                        <input type="hidden" name="userId" value={u.id} />
                        <input type="hidden" name="status" value="ACTIVE" />
                        <button className="crm-btn-sm" type="submit">Reactivate</button>
                      </form>
                    ) : (
                      <form action={setUserStatusAction}>
                        <input type="hidden" name="userId" value={u.id} />
                        <input type="hidden" name="status" value="DISABLED" />
                        <button className="crm-btn-sm" type="submit" disabled={u.id === session.userId}>Disable</button>
                      </form>
                    )}
                    <form action={removeUserAction}>
                      <input type="hidden" name="userId" value={u.id} />
                      <button className="crm-btn-sm crm-btn-danger" type="submit" disabled={u.id === session.userId}>Remove</button>
                    </form>
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>

      {invites.length > 0 ? (
        <div style={{ marginTop: 22 }}>
          <h3 style={{ fontSize: 14 }}>Pending invitations</h3>
          <table className="crm-table">
            <thead><tr><th>Email</th><th>Role</th><th>Invited</th></tr></thead>
            <tbody>
              {invites.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td>
                  <td><span className="crm-badge role">{SYSTEM_ROLE_LABELS[i.systemRole]}</span></td>
                  <td className="crm-faint">{fmtDate(i.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
