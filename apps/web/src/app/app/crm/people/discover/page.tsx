import Link from 'next/link';
import { CRM_DISCOVERY_DISMISS_LABELS, CRM_DISCOVERY_DISMISS_REASONS, CRM_DISCOVERY_REASON_LABELS, CRM_ORIGIN_GMAIL_DISCOVERY } from '@emgloop/shared';
import { hasPermission, requirePermission } from '../../../../../auth/guard';
import { PEOPLE_HREF } from '../../../../../crm/crm-slice-data';
import { DISCOVER_HREF, readDiscovery } from '../../../../../crm/outreach-data';
import { addDiscoveredPersonAction, dismissDiscoveredAction, restoreDiscoveredAction } from '../../../../../crm/outreach-actions';
import { mailFreshnessText } from '../../../../../crm/outreach-display';
import { LoopPage, PageHead, Panel, StateBlock } from '../../../_loop-os/record';

export const dynamic = 'force-dynamic';

// Possible New People (CRM slice 6). docs/architecture/crm-people-command-center.md §Discovery.
//
// YOUR queue, from YOUR mail: addresses from a qualifying direct exchange that no CRM Contact Point holds.
// A legitimate human inbound can surface before you reply; own, internal, automated and list/role addresses
// are removed by fixed rules, and
// the reason each one surfaced. Nobody else sees it, and nothing here happens on its own:
//   - ADD TO PEOPLE shows exactly what will be created, re-checks the address at the moment you click,
//     and creates one established PERSON with that email as a Contact Point -- through the Party and
//     Contact Point authorities, attributed to you. No Company, Opportunity, Relationship or
//     affiliation is created, and no Company is inferred from the domain.
//   - Ignore / Not a person / Internal / Automated / Not relevant hides it from your queue only, and
//     can be restored.
// No model decides anything here.

const OUTCOME: Readonly<Record<string, { kind: 'attention' | 'denied' | 'empty'; title: string; body: string }>> = {
  DISMISSED: { kind: 'empty', title: 'Dismissed from your queue.', body: 'Only your queue changed. You can restore it from Dismissed.' },
  RESTORED: { kind: 'empty', title: 'Restored to your queue.', body: '' },
  NOT_AUTHORIZED: { kind: 'denied', title: 'You cannot add people here.', body: 'Adding a person establishes canonical identity, which is held by workspace owners and administrators.' },
  NOT_FOUND: { kind: 'attention', title: 'That address is no longer in your mail.', body: '' },
  NAME_REQUIRED: { kind: 'attention', title: 'A name is needed.', body: "Type the person's name as you know it. Loop never makes one from an address." },
  ADDRESS_INVALID: { kind: 'attention', title: 'That address cannot be recorded as a contact point.', body: '' },
  AMBIGUOUS: { kind: 'attention', title: 'That address is held by more than one record.', body: 'Resolve it in identity review before adding anyone.' },
  REATTRIBUTION_REQUIRED: {
    kind: 'attention',
    title: "That address is recorded as a company's shared or unattributed inbox.",
    body: "It was not turned into a person. To attribute it to a person, retire it on the company's contact points first, then add the person.",
  },
  REFUSED_PARTY_CREATE: { kind: 'attention', title: 'The person could not be created.', body: 'Nothing was recorded.' },
  REFUSED_PARTY_ESTABLISH: { kind: 'attention', title: 'The person could not be established.', body: 'Nothing was recorded.' },
  REFUSED_CONTACT_POINT: { kind: 'attention', title: 'The email could not be recorded.', body: 'Nothing was recorded.' },
  INVALID: { kind: 'attention', title: 'That was not a valid reason.', body: '' },
};

export default async function DiscoverPage({ searchParams }: { searchParams?: { outcome?: string; show?: string } }) {
  await requirePermission('identityResolution', 'view');
  const canEstablish = await hasPermission('identityResolution', 'approve');
  const { result, time } = await readDiscovery();
  const trail = [{ label: 'CRM' }, { label: 'People', href: PEOPLE_HREF }, { label: 'Possible new people', href: DISCOVER_HREF }];
  const notice = searchParams?.outcome ? OUTCOME[searchParams.outcome] : undefined;
  const showDismissed = searchParams?.show === 'dismissed';

  return (
    <LoopPage label="Possible new people">
      <PageHead trail={trail} title="Possible new people" subtitle="People you have emailed — or who contacted you directly — who are not in People yet. Your queue, from your own mail." />
      {notice ? <StateBlock kind={notice.kind} compact title={notice.title} body={notice.body} /> : null}

      {result === null ? (
        <StateBlock kind="unavailable" title="Possible new people is not available here yet." body="This workspace's database does not have the outreach records yet." />
      ) : result.outcome === 'NOT_AUTHORIZED' ? (
        <StateBlock kind="denied" title="You cannot view people in this workspace." body="Your membership does not include canonical identity." />
      ) : result.outcome === 'MAIL_UNAVAILABLE' ? (
        <StateBlock kind="unavailable" title="Your Gmail is not available." body="This queue is read from your own mail. Connect Gmail (or wait for its first read) and it will appear." action={{ label: 'Open connections', href: '/app/connections' }} />
      ) : (
        <>
          <StateBlock kind={result.mail.gmail.state === 'FRESH' ? 'empty' : 'attention'} compact title={mailFreshnessText(result.mail.gmail, time)} body="Direct human exchanges are considered, including legitimate inbound-first contacts. Your own, internal, automated, shared-inbox and list addresses, and anyone already in the CRM, are left out." />
          <nav className="loop-filters" aria-label="Queue">
            <Link className="loop-filter" href={DISCOVER_HREF} aria-current={!showDismissed ? 'true' : undefined}>To review · {result.candidates.length}</Link>
            <Link className="loop-filter" href={`${DISCOVER_HREF}?show=dismissed`} aria-current={showDismissed ? 'true' : undefined}>Dismissed · {result.dismissed.length}</Link>
          </nav>

          {!showDismissed ? (
            result.candidates.length === 0 ? (
              <StateBlock kind="empty" title="Nobody new to review." body="Everyone in a qualifying direct exchange is either in People already or was left out by the rules above." />
            ) : (
              <div className="loop-stack">
                {result.candidates.map((c) => (
                  <Panel key={c.correspondentHash} title={c.proposedName ?? c.address}>
                    <ul className="loop-note" style={{ margin: '0 0 10px', paddingLeft: 18 }}>
                      <li>Email: {c.address}</li>
                      <li>Company: no governed company match (a company is never inferred from the domain)</li>
                      <li>Creator context: none recorded</li>
                      <li>
                        First seen {time.date(c.firstObservedAt)}, last seen {time.relative(c.lastObservedAt)} · {c.directSends > 0 ? `you wrote to them ${c.directSends} ${c.directSends === 1 ? 'time' : 'times'}` : 'they contacted you before you replied'}
                        {c.humanReplies > 0 ? `, human inbound observed ${c.humanReplies} ${c.humanReplies === 1 ? 'time' : 'times'}` : ', no human inbound observed'}
                      </li>
                      {c.recentThread ? (
                        <li>
                          Most recent: {c.recentThread.direction === 'OUTBOUND' ? 'you wrote' : 'they wrote'} {time.relative(c.recentThread.at)}
                          {c.recentThread.subject ? ` — “${c.recentThread.subject}”` : ''} · <Link href={`/app/mail/${encodeURIComponent(c.recentThread.threadId)}`}>Open in Mail</Link>
                        </li>
                      ) : null}
                      <li>Why it surfaced: {c.reasons.map((r) => CRM_DISCOVERY_REASON_LABELS[r]).join('; ')}</li>
                    </ul>

                    <details>
                      <summary className="loop-btn loop-btn--primary" style={{ display: 'inline-flex' }}>Add to People…</summary>
                      <form action={addDiscoveredPersonAction} className="loop-stack" style={{ marginTop: 12 }}>
                        <input type="hidden" name="candidate" value={c.correspondentHash} />
                        <p className="loop-note">This will create, attributed to you:</p>
                        <ul className="loop-note" style={{ margin: 0, paddingLeft: 18 }}>
                          <li>one Person, established by you (manual basis);</li>
                          <li>{c.address} as their email contact point (individual);</li>
                          <li>a provenance record: “{CRM_ORIGIN_GMAIL_DISCOVERY}”.</li>
                        </ul>
                        <p className="loop-note">No company, opportunity, relationship or affiliation is created. The address is checked again when you click.</p>
                        <label className="loop-field" style={{ maxWidth: 360 }}>
                          <span className="loop-label">Name</span>
                          <input className="loop-input" name="name" required minLength={2} maxLength={120} defaultValue={c.proposedName ?? ''} placeholder="Their name, as you know it" />
                        </label>
                        {canEstablish ? (
                          <button className="loop-btn loop-btn--primary" type="submit" style={{ alignSelf: 'flex-start' }}>Add to People</button>
                        ) : (
                          <p className="loop-note">Establishing a person is held by workspace owners and administrators; ask one to add them.</p>
                        )}
                      </form>
                    </details>

                    <form action={dismissDiscoveredAction} className="loop-filters" style={{ alignItems: 'flex-end', marginTop: 10 }}>
                      <input type="hidden" name="candidate" value={c.correspondentHash} />
                      <label className="loop-field">
                        <span className="loop-label">Dismiss as</span>
                        <select className="loop-select" name="reason" defaultValue="IGNORE">
                          {CRM_DISCOVERY_DISMISS_REASONS.map((r) => (
                            <option key={r} value={r}>{CRM_DISCOVERY_DISMISS_LABELS[r]}</option>
                          ))}
                        </select>
                      </label>
                      <button className="loop-btn loop-btn--quiet" type="submit">Dismiss</button>
                    </form>
                  </Panel>
                ))}
              </div>
            )
          ) : result.dismissed.length === 0 ? (
            <StateBlock kind="empty" title="Nothing dismissed." body="Addresses you dismiss from your queue are listed here and can be restored." />
          ) : (
            <table className="loop-table">
              <caption className="loop-sr-only">Addresses you dismissed</caption>
              <thead>
                <tr>
                  <th scope="col">Address</th>
                  <th scope="col">Dismissed as</th>
                  <th scope="col">When</th>
                  <th scope="col">Restore</th>
                </tr>
              </thead>
              <tbody>
                {result.dismissed.map((d) => (
                  <tr key={d.addressHash}>
                    <td>{d.displayName ? `${d.displayName} · ` : ''}{d.displayAddress}</td>
                    <td data-label="Dismissed as">{CRM_DISCOVERY_DISMISS_LABELS[d.reason as keyof typeof CRM_DISCOVERY_DISMISS_LABELS] ?? d.reason}</td>
                    <td data-label="When">{time.date(d.dismissedAt)}</td>
                    <td data-label="Restore">
                      <form action={restoreDiscoveredAction}>
                        <input type="hidden" name="candidate" value={d.addressHash} />
                        <button className="loop-btn loop-btn--quiet" type="submit">Restore</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </LoopPage>
  );
}
