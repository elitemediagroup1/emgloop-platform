// A Person's outreach: where the conversation stands, what is next, and everything that happened,
// each with its source and time (CRM slice 6). Server component. docs/architecture/crm-people-command-center.md.
//
// The timeline is facts and acts, newest first: imported history (with its precision, or "unknown
// time"), notes, the state changes people made, and -- for the viewer only -- their own sends,
// replies and meetings. Reply content is never copied here: a mail entry links to the viewer's own
// thread in Mail, which reads it through on demand under their own Google connection.

import Link from 'next/link';
import { CRM_HUMAN_CONVERSATION_STATES, CRM_CONVERSATION_STATE_LABELS, type TimeView } from '@emgloop/shared';
import type { CrmPersonOutreachResult } from '@emgloop/database';

import { Facts, Panel, StateBlock } from '../app/app/_loop-os/record';
import { recordNoteAction, retractFactAction, setConversationStateAction, setNextActionAction } from './outreach-actions';
import {
  basisText,
  cadenceText,
  conversationState,
  dueText,
  factTime,
  lastTouchText,
  mailFreshnessText,
  replyText,
  reviewText,
  OUTREACH_OUTCOME_TEXT,
} from './outreach-display';

type Ok = Extract<CrmPersonOutreachResult, { outcome: 'OK' }>;

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  IMPORT: 'Import',
  OPERATOR: 'Recorded',
  CRM: 'CRM',
  GMAIL: 'Your Gmail',
  CALENDAR: 'Your calendar',
};

export function OutreachNotice({ outcome }: { outcome: string | undefined }) {
  const text = outcome ? OUTREACH_OUTCOME_TEXT[outcome] : undefined;
  if (!text) return null;
  return <StateBlock kind={text.kind} compact title={text.title} body={text.body ?? ''} />;
}

export function PersonOutreach({ read, time }: { read: CrmPersonOutreachResult | null; time: TimeView }) {
  if (read === null) {
    return (
      <Panel title="Outreach">
        <StateBlock kind="unavailable" compact title="Outreach is not available here yet." body="This workspace's database does not have the outreach records yet." />
      </Panel>
    );
  }
  if (read.outcome !== 'OK') {
    return (
      <Panel title="Outreach">
        <StateBlock kind={read.outcome === 'NOT_AUTHORIZED' ? 'denied' : 'attention'} compact title={read.outcome === 'NOT_AUTHORIZED' ? 'You cannot view outreach.' : 'Outreach is not available for this record.'} body="" />
      </Panel>
    );
  }
  return (
    <>
      <OutreachNow read={read} time={time} />
      <OutreachTimeline read={read} time={time} />
    </>
  );
}

function OutreachNow({ read, time }: { read: Ok; time: TimeView }) {
  const o = read.row.outreach;
  const state = conversationState(o.state);
  const review = reviewText(o.reviewReason);
  const due = dueText(o, time);
  const partyId = read.row.partyId;
  const caps = read.capabilities;
  return (
    <section id="outreach" aria-label="Outreach">
      <Panel title="Where this conversation stands">
        <p className="loop-panel__lead">
          <span className={`loop-pill loop-pill--${state.tone}`}>{state.label}</span>{' '}
          <span className="loop-note">{basisText(o.basis)}</span>
          {o.humanState && o.basis !== 'HUMAN' ? <span className="loop-note"> · a person had set {CRM_CONVERSATION_STATE_LABELS[o.humanState]}</span> : null}
        </p>
        {review ? <p className="loop-note">{review}</p> : null}
        <Facts
          rows={[
            { label: 'Next action', value: o.nextAction.kind === 'NONE' ? null : `${o.nextAction.label}${due ? ` — ${due}` : ''}`, unknownText: 'No next action set' },
            { label: 'Cadence', value: cadenceText(o) },
            { label: 'Last touch', value: lastTouchText(o, time) },
            { label: 'Last outreach (your Gmail)', value: read.lastOutboundAt ? time.dateTime(read.lastOutboundAt) : null, unknownText: read.mail.gmail.state === 'UNAVAILABLE' ? 'Gmail data unavailable' : 'None observed' },
            { label: 'Last inbound (your Gmail)', value: read.lastInboundAt ? time.dateTime(read.lastInboundAt) : null, unknownText: read.mail.gmail.state === 'UNAVAILABLE' ? 'Gmail data unavailable' : 'None observed' },
            { label: 'Reply', value: replyText(o, read.mail.gmail, time) },
            {
              label: 'Upcoming meeting',
              value: read.nextMeeting ? `${read.nextMeeting.title ?? 'Meeting'} — ${time.dateTime(read.nextMeeting.at)}` : null,
              unknownText: read.mail.calendar === 'UNAVAILABLE' ? 'Calendar data unavailable' : 'None on your calendar',
            },
          ]}
        />
        <p className="loop-note" style={{ marginTop: 10 }}>
          {read.mail.permitted ? mailFreshnessText(read.mail.gmail, time) : 'Your membership does not include your own mail intelligence.'} Mail and calendar facts here are yours alone.
        </p>

        {caps.setState ? (
          <form action={setConversationStateAction} className="loop-filters" style={{ alignItems: 'flex-end', marginTop: 14 }}>
            <input type="hidden" name="partyId" value={partyId} />
            <label className="loop-field">
              <span className="loop-label">Set conversation state</span>
              <select className="loop-select" name="state" defaultValue={o.humanState ?? 'CLEAR'}>
                <option value="CLEAR">None set (derive from facts)</option>
                {CRM_HUMAN_CONVERSATION_STATES.map((s) => (
                  <option key={s} value={s}>{CRM_CONVERSATION_STATE_LABELS[s]}</option>
                ))}
              </select>
            </label>
            <button className="loop-btn" type="submit">Save state</button>
          </form>
        ) : null}
        {caps.setNextAction ? (
          <form action={setNextActionAction} className="loop-filters" style={{ alignItems: 'flex-end', marginTop: 10 }}>
            <input type="hidden" name="partyId" value={partyId} />
            <label className="loop-field" style={{ flex: '1 1 260px' }}>
              <span className="loop-label">Next action</span>
              <input className="loop-input" name="text" maxLength={200} required placeholder="e.g. Send the rate card" />
            </label>
            <label className="loop-field">
              <span className="loop-label">Due</span>
              <input className="loop-input" type="date" name="dueDate" />
            </label>
            <button className="loop-btn" type="submit">Set next action</button>
          </form>
        ) : null}
        {caps.setNextAction && o.nextAction.kind === 'HUMAN' ? (
          <form action={setNextActionAction} style={{ marginTop: 8 }}>
            <input type="hidden" name="partyId" value={partyId} />
            <input type="hidden" name="clear" value="1" />
            <button className="loop-btn loop-btn--quiet" type="submit">Clear next action</button>
          </form>
        ) : null}
        {!caps.setState ? <p className="loop-note">Setting a state or next action is not part of your membership.</p> : null}
      </Panel>
    </section>
  );
}

function OutreachTimeline({ read, time }: { read: Ok; time: TimeView }) {
  const partyId = read.row.partyId;
  return (
    <Panel title="Timeline">
      {read.capabilities.recordNote ? (
        <form action={recordNoteAction} className="loop-filters" style={{ alignItems: 'flex-end', marginBottom: 14 }}>
          <input type="hidden" name="partyId" value={partyId} />
          <label className="loop-field">
            <span className="loop-label">Record</span>
            <select className="loop-select" name="kind" defaultValue="NOTE">
              <option value="NOTE">A note</option>
              <option value="TITLE">Their title</option>
            </select>
          </label>
          <label className="loop-field" style={{ flex: '1 1 320px' }}>
            <span className="loop-label">Text</span>
            <textarea className="loop-textarea" name="text" maxLength={2000} rows={2} required />
          </label>
          <button className="loop-btn" type="submit">Save</button>
        </form>
      ) : null}
      {read.timeline.length === 0 ? (
        <StateBlock kind="empty" compact title="Nothing recorded yet." body={read.mail.gmail.state === 'UNAVAILABLE' ? 'Your Gmail is not available, so your sends and replies cannot appear.' : 'No import history, note, state change, mail or meeting is recorded for this person.'} />
      ) : (
        <ol className="loop-stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {read.timeline.map((e) => (
            <li key={e.key} style={{ borderLeft: '2px solid var(--loop-line)', paddingLeft: 12, opacity: e.retracted ? 0.6 : 1 }}>
              <div style={{ fontSize: 12.5, color: 'var(--loop-muted)' }}>
                {factTime(e.at, e.precision, time)} · {SOURCE_LABEL[e.source] ?? e.source}
                {e.private ? ' · only you see this' : ''}
                {e.retracted ? ' · retracted' : ''}
              </div>
              <div className="loop-table__strong">{e.title}</div>
              {e.detail ? <div className="loop-note">{e.detail}</div> : null}
              {e.threadId ? (
                <Link className="loop-note" href={`/app/mail/${encodeURIComponent(e.threadId)}`}>Open in Mail</Link>
              ) : null}
              {e.factId && !e.retracted && read.capabilities.retractFact ? (
                <form action={retractFactAction} style={{ display: 'inline', marginLeft: 8 }}>
                  <input type="hidden" name="partyId" value={partyId} />
                  <input type="hidden" name="factId" value={e.factId} />
                  <button className="loop-btn loop-btn--quiet" type="submit" style={{ minHeight: 0, padding: '2px 8px', fontSize: 12 }}>Retract</button>
                </form>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/** The rail: title, company and creator context, origin -- each with its basis. */
export function PersonContext({ read, time }: { read: CrmPersonOutreachResult | null; time: TimeView }) {
  if (!read || read.outcome !== 'OK') return null;
  const current = read.facts.filter((f) => f.retractedAt === null);
  const latest = (kind: string) => current.find((f) => f.kind === kind) ?? null;
  const title = latest('TITLE');
  const company = latest('COMPANY_CONTEXT');
  const creator = latest('CREATOR_CONTEXT');
  const origin = latest('ORIGIN');
  const status = latest('SOURCE_STATUS');
  const basis = (f: { basis: string } | null) => (f ? (f.basis === 'IMPORTED' ? ' (imported)' : ' (recorded)') : '');
  return (
    <Panel title="Context">
      <Facts
        rows={[
          { label: 'Title', value: title?.text ? `${title.text}${basis(title)}` : null, unknownText: 'None recorded' },
          { label: 'Company', value: company?.relatedPartyId ? `${read.names.get(company.relatedPartyId) ?? company.text ?? 'A company'}${basis(company)}` : null, unknownText: 'None recorded' },
          { label: 'Creator', value: creator?.text ? `${creator.relatedPartyId ? read.names.get(creator.relatedPartyId) ?? creator.text : creator.text}${basis(creator)}` : null, unknownText: 'None recorded' },
          { label: 'Source status', value: status?.text ?? null, unknownText: 'None recorded' },
          { label: 'Origin', value: origin?.text ? `${origin.text} · ${factTime(origin.occurredAt, origin.occurredAtPrecision, time)}` : read.row.origin === 'IMPORTED' ? 'Imported' : null, unknownText: 'Added in Loop' },
        ]}
      />
      <p className="loop-note" style={{ marginTop: 10 }}>
        Company and creator context say where this person came from. They are not a Relationship, an affiliation or an Opportunity.
      </p>
    </Panel>
  );
}
