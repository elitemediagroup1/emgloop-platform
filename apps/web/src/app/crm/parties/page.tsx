// Parties -- the governed canonical identity surface. OPERATOR TOOLING, TEMPORARY.
//
// WHAT THIS IS. The smallest honest surface that lets an authorized person use the
// Party authority that already exists: create a PERSON or COMPANY record, establish
// it on a governed basis, and see what is established. Before this page, that
// authority had no caller at all, so production held zero established Parties and
// every Relationship, People and Companies surface was empty BY CONSTRUCTION.
//
// WHAT THIS IS NOT. It is not the People or Companies experience. Charlie and Lexi
// own that design, and this page deliberately looks like engineering tooling so
// nobody mistakes it for their work. It should be deleted when their surface lands.
//
// A PARTY IS NOT AN INTAKE RECORD, and the page says so rather than assuming the
// reader knows. Intake Records are the 24,590 legacy rows ingestion created from
// caller IDs; a Party is a governed identity somebody deliberately established. This
// page never converts one into the other, never matches on a phone number or an
// email, and never establishes anything without a person submitting a form.

import Link from 'next/link';
import { requirePermission } from '../../../auth/guard';
import { loadCompanies, loadEstablishmentQueue, loadPeople } from '../../../crm/party-data';
import { operatorCreatePartyAction, operatorEstablishPartyAction } from '../../../crm/party-operator-actions';
import type { PartyListPageV1 } from '@emgloop/shared';
import { viewerTime } from '../../../time/viewer-time';
import { OperatorNotice, Outcome } from '../_operator/OperatorNotice';

export const dynamic = 'force-dynamic';

const OUTCOMES: Record<string, string> = {
  RECORDED: 'Recorded.',
  ALREADY_ESTABLISHED: 'That Party was already established. Nothing changed.',
  NOT_AUTHORIZED: 'You do not have authority for that act.',
  NOT_FOUND: 'Not found.',
  INVALID: 'That is not a valid request.',
};

const REASONS: Record<string, string> = {
  NOT_A_PARTY_TYPE: 'A Party is a PERSON or a COMPANY. Nothing else is one.',
  NOT_A_GOVERNED_BASIS: 'Establishment needs a governed basis: MANUAL or EXPLICIT_LINK.',
  ARCHIVED: 'That record is archived. An archived Party is not established.',
  MISSING_FIELD: 'Something required was not filled in.',
};

export default async function PartiesPage({
  searchParams,
}: {
  searchParams: { outcome?: string; reason?: string; partyId?: string };
}) {
  // The page guards itself. `PartyRecordService` then checks identityResolution:view
  // again before it reads anything -- a layout is never a page's only boundary.
  await requirePermission('identityResolution', 'view');
  const time = viewerTime();

  const [people, companies, queue] = await Promise.all([
    loadPeople({ limit: 25 }),
    loadCompanies({ limit: 25 }),
    loadEstablishmentQueue({ limit: 25 }),
  ]);

  if (people.outcome !== 'OK' || companies.outcome !== 'OK' || queue.outcome !== 'OK') {
    return (
      <div className="crm-page">
        <div className="crm-page-head"><div><h1>Parties</h1></div></div>
        <div className="crm-panel"><p className="crm-sub">You do not have authority to read canonical identity.</p></div>
      </div>
    );
  }

  // Server-decided. The page offers only what the server would allow anyway, and the
  // server refuses again if a form is submitted regardless.
  const may = people.capabilities;

  return (
    <div className="crm-page">
      <div className="crm-page-head">
        <div>
          <h1>Parties</h1>
          <p className="crm-sub">
            Canonical identity: a <strong>Person</strong> or a <strong>Company</strong> somebody deliberately
            established. Not <Link className="crm-link" href="/crm/customers">Intake Records</Link>, which are
            what ingestion recorded before anybody decided who they were.
          </p>
        </div>
      </div>

      <OperatorNotice />
      <Outcome outcome={searchParams.outcome} messages={OUTCOMES} detail={REASONS[searchParams.reason ?? '']} />

      <div className="crm-panel">
        <h2 className="crm-h2">Record a Party</h2>
        <p className="crm-sub">
          Creating a record does not establish it. It exists, unestablished, until somebody with the
          authority says it is canonical identity — which is a separate act, below.
        </p>
        {may.createParty ? (
          <form action={operatorCreatePartyAction} className="crm-form-row">
            <label>
              Type
              <select name="partyType" defaultValue="PERSON">
                <option value="PERSON">Person</option>
                <option value="COMPANY">Company</option>
              </select>
            </label>
            <label>
              Display name (optional)
              <input name="displayName" type="text" maxLength={200} placeholder="How this record should read" />
            </label>
            <button className="crm-btn" type="submit">Create record</button>
          </form>
        ) : (
          <p className="crm-sub">You do not have authority to create a Party record.</p>
        )}
      </div>

      <div className="crm-panel">
        <h2 className="crm-h2">Awaiting establishment ({queue.value.items.length})</h2>
        {queue.value.items.length === 0 ? (
          <p className="crm-sub">Nothing is waiting. A record appears here after it is created and before it is established.</p>
        ) : (
          <table className="crm-table">
            <thead><tr><th>Record</th><th>Type</th><th>Created</th><th>Establish</th></tr></thead>
            <tbody>
              {queue.value.items.map((item) => (
                <tr key={item.partyId}>
                  <td><Link className="crm-link" href={`/crm/parties/${item.partyId}`}>{item.displayName ?? item.partyId}</Link></td>
                  <td>{item.partyType}</td>
                  <td>{time.monthDayTime(item.createdAt)}</td>
                  <td>
                    {may.establishParty ? (
                      <form action={operatorEstablishPartyAction}>
                        <input type="hidden" name="partyId" value={item.partyId} />
                        {/* Stated explicitly. There is no default basis, because a
                            default basis is a decision nobody made. */}
                        <select name="basis" defaultValue="MANUAL">
                          <option value="MANUAL">MANUAL</option>
                          <option value="EXPLICIT_LINK">EXPLICIT_LINK</option>
                        </select>
                        <button className="crm-btn" type="submit">Establish</button>
                      </form>
                    ) : (
                      <span className="crm-sub">Needs establishment authority</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <PartyList title="People" subtitle="Established PERSON Parties." page={people.value} time={time} />
      <PartyList title="Companies" subtitle="Established COMPANY Parties. Never the workspace itself." page={companies.value} time={time} />
    </div>
  );
}

function PartyList({
  title, subtitle, page, time,
}: {
  title: string;
  subtitle: string;
  page: PartyListPageV1;
  time: ReturnType<typeof viewerTime>;
}) {
  return (
    <div className="crm-panel">
      <h2 className="crm-h2">{title} ({page.items.length})</h2>
      <p className="crm-sub">{subtitle}</p>
      {page.items.length === 0 ? (
        <p className="crm-sub">
          None yet. This is the correct answer until somebody establishes one — it is not a loading state
          and nothing will fill it in automatically.
        </p>
      ) : (
        <table className="crm-table">
          <thead><tr><th>Name</th><th>Established</th><th>Basis</th></tr></thead>
          <tbody>
            {page.items.map((item) => (
              <tr key={item.partyId}>
                <td><Link className="crm-link" href={`/crm/parties/${item.partyId}`}>{item.displayName ?? item.partyId}</Link></td>
                <td>{item.establishment.establishedAt ? time.monthDayTime(item.establishment.establishedAt) : '—'}</td>
                {/* The governed basis somebody stated, shown rather than summarised away. */}
                <td>{item.establishment.basis ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
