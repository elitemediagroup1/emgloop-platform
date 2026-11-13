import Link from 'next/link';
import type { AccessRequestRepository } from '@emgloop/database';
import { ACCESS_REQUEST_TYPES, SYSTEM_ROLES, SYSTEM_ROLE_LABELS } from '@emgloop/database';
import { inviteUserAction, recordAccessRequestAction, rejectAccessRequestAction } from '../../../../../crm/admin-actions';

type Request = Awaited<ReturnType<AccessRequestRepository['list']>>[number];
export function AccessRequestsPanel({ rows, history, historyView, available, organizationId, routed, people, date, nextHref }: {
  rows: Request[]; history: Request[]; historyView: boolean; available: boolean; organizationId: string; routed: boolean;
  people: { partyId: string; displayName: string | null }[]; date: (iso: string) => string; nextHref: string | null;
}) {
  const requests = historyView ? history : rows;
  return <section className="adm-card" aria-labelledby="access-requests">
    <h2 className="adm-card__title" id="access-requests">Access requests</h2>
    <p>Review who wants to join. Approving sends a secure invitation; they set up their own account before gaining access.</p>
    <nav className="adm-inline" aria-label="Access request views"><Link href="?accessView=pending#access-requests">Waiting for review</Link><Link href="?accessView=history#access-requests">Reviewed requests</Link></nav>
    {!routed ? <p role="status">Public requests are not routed to this workspace. Set the server environment variable <code>LOOP_ACCESS_REQUEST_ORGANIZATION_ID</code> to <code>{organizationId}</code> in Netlify, then redeploy.</p> : null}
    {!available ? <p role="alert">Access requests could not load. Existing team invitations are still available below. If this feature was just deployed, complete its database migration first.</p> : requests.length === 0 ? <p className="adm-empty">{historyView ? 'No reviewed requests yet.' : 'No access requests are waiting for review. Requests previously received only by email can be recorded below.'}</p> : <div className="adm-tablewrap"><table className="adm-table"><thead><tr><th>Person</th><th>Requested access</th><th>Received</th><th>Status</th><th>Decision</th></tr></thead><tbody>
      {requests.map(request => <tr key={request.id}>
        <td>{request.fullName}<div className="adm-faint">{request.email}</div><div className="adm-faint">{request.company}</div></td>
        <td>{request.accessType}</td><td>{date(request.submittedAt.toISOString())}</td>
        <td>{request.status === 'INVITED' ? request.invitation?.status === 'ACCEPTED' ? 'Onboarded' : request.invitation?.status === 'REVOKED' ? 'Invitation revoked' : request.invitation && request.invitation.expiresAt.getTime() < Date.now() ? 'Invitation expired' : 'Invitation sent' : request.status === 'PROCESSING' ? 'Processing; retry after five minutes if interrupted' : request.status === 'FAILED' ? 'Invitation failed; retry available' : request.status === 'RESOLVED' ? 'Existing member or invitation' : request.status === 'REJECTED' ? 'Rejected' : 'Waiting for review'}</td>
        <td>{!historyView ? <>
          <form action={inviteUserAction} className="adm-inviteform">
            <input type="hidden" name="accessRequestId" value={request.id} />
            <label className="adm-field"><span className="adm-field__label">Approved role</span><select className="adm-input" name="role" defaultValue={request.accessType === 'Creator' ? 'CREATOR' : 'EMPLOYEE'}>{SYSTEM_ROLES.map(role => <option key={role} value={role}>{SYSTEM_ROLE_LABELS[role]}</option>)}</select></label>
            <label className="adm-field"><span className="adm-field__label">Person identity (Creator only)</span><select className="adm-input" name="creatorPartyId" defaultValue="__new__"><option value="__new__">Create their Person identity</option>{people.map(person => <option key={person.partyId} value={person.partyId}>{person.displayName ?? 'Unnamed Person'}</option>)}</select></label>
            <button className="adm-btn adm-btn--primary" type="submit">{request.status === 'FAILED' || request.status === 'PROCESSING' ? 'Retry invitation' : 'Approve & send invitation'}</button>
          </form>
          <form action={rejectAccessRequestAction}><input type="hidden" name="accessRequestId" value={request.id}/><button className="adm-btn adm-btn--danger" type="submit" disabled={request.status === 'PROCESSING'}>Reject request</button></form>
        </> : request.decidedAt ? <span className="adm-faint">Reviewed {date(request.decidedAt.toISOString())}</span> : null}</td>
      </tr>)}
    </tbody></table></div>}
    {nextHref ? <Link href={nextHref}>More access requests →</Link> : null}
    {available ? <details><summary>Record a request received by email</summary><p>For requests submitted before this queue existed. This records the request only; review it above to send an invitation.</p><form action={recordAccessRequestAction} className="adm-inviteform">
      <label className="adm-field"><span className="adm-field__label">Full name</span><input className="adm-input" name="fullName" maxLength={100} required /></label>
      <label className="adm-field"><span className="adm-field__label">Email</span><input className="adm-input" type="email" name="email" maxLength={254} required /></label>
      <label className="adm-field"><span className="adm-field__label">Company</span><input className="adm-input" name="company" maxLength={150} required /></label>
      <label className="adm-field"><span className="adm-field__label">Requested access</span><select className="adm-input" name="accessType">{ACCESS_REQUEST_TYPES.map(type => <option key={type}>{type}</option>)}</select></label>
      <button className="adm-btn" type="submit">Record request</button>
    </form></details> : null}
  </section>;
}
