import Link from 'next/link';
import { absentUntilMigrated } from '@emgloop/database';
import { notFound } from 'next/navigation';
import { hasPermission, requirePermission } from '../../../../../auth/guard';
import { ContactPointList } from '../../../../../crm/contact-point-list';
import { crmSubjectReads, personHref, PEOPLE_HREF, readContactPoints, relationshipHref } from '../../../../../crm/crm-slice-data';
import { readPersonView } from '../../../../../crm/crm-subject-reads';
import { governedTerm, partyIdentityState } from '../../../../../crm/subject-display';
import { viewerTime } from '../../../../../time/viewer-time';
import { readPersonOutreach } from '../../../../../crm/outreach-data';
import { OutreachNotice, PersonContext, PersonOutreach } from '../../../../../crm/person-outreach';
// Creator Hub (2026-09-22): when a creator profile exists for this person, their operating
// view (opportunities, campaigns, work in production) lives in Creator Operations. Only a
// seat that can open that tree gets a link; anyone else is told where it is, honestly.
import { creatorDomain, EMG_HREFS } from '../../../../../creator/creator-runtime';
import { resolveWorkspaceRole } from '../../../../../workspaces/role-router';
import {
  ActionButton,
  ContextTabs,
  Facts,
  LoopPage,
  Panel,
  PageHead,
  ReadFailed,
  RecordLayout,
  StateBlock,
} from '../../../_loop-os/record';
import { SubjectCard } from '../../../_loop-os/subject-card';

export const dynamic = 'force-dynamic';

// A Person record (handoff 2026-09-16, pp. 6-7): who the person is, how Loop knows
// them, their relationship context and what is happening around them.
//
// REAL DATA ONLY. Identity comes from PartyRecordService, context from the
// Relationships authority. What no authority answers yet is said, never filled:
//   - Email, Call and Message: a Party has no governed communication channel, so
//     the actions are shown as unavailable and do nothing. Recorded Contact Points
//     (PD-F-05) are shown -- values only to EMPLOYEE and above -- but recording an
//     address is not a channel, and nothing here sends.
//   - Opportunities, Campaigns and open Work: no authority links them to a Party.
//   - Intelligence: no Party subject exists in it yet.
// Outreach (CRM slice 6) is shown: the conversation state, next action, cadence and a timeline of
// imported history, notes, state changes and -- for the viewer only -- their own mail and meetings.
// States: Established; Identity review required; Superseded (points to the current
// person, history kept); Archived (history kept, new commercial action restricted).
// A missing, foreign or non-person id is not found.

const LIMITATION_TEXT: Record<string, string> = {
  EVIDENCE_NOT_COLLECTED: 'No identity evidence is collected yet: establishment is a decision a person made, not a verification.',
  VERIFICATION_NOT_AVAILABLE: 'No contact detail has a recorded verification.',
};

export default async function PersonPage({ params, searchParams }: { params: { partyId: string }; searchParams?: { outcome?: string } }) {
  const session = await requirePermission('identityResolution', 'view');
  const view = await readPersonView(await crmSubjectReads(), params.partyId, { relationship: relationshipHref });
  const trailBase = [{ label: 'CRM' }, { label: 'People', href: PEOPLE_HREF }];
  if (view.outcome !== 'OK') {
    if (view.outcome === 'NOT_FOUND') notFound();
    return (
      <LoopPage label="Person">
        <PageHead trail={[...trailBase, { label: 'Person' }]} title="Person" />
        <ReadFailed what="this person" />
      </LoopPage>
    );
  }

  const { record, subject, context } = view;
  const time = viewerTime();
  const state = partyIdentityState(record);
  const canOpenIntake = await hasPermission('customers', 'view');
  const activeLinks = record.linkedIntakeRecords.filter((l) => l.state === 'ACTIVE');
  const relationships = view.relationships;
  const contactPoints = await readContactPoints(record.partyId);
  const outreach = state === 'ESTABLISHED' ? (await readPersonOutreach(record.partyId)).result : null;

  // A creator profile for this person, within the session's organization. Its operating view
  // is in the ADMIN tree, so the link exists only for a seat that can open it.
  // Absent, not broken, while the Creator Hub migration has not reached this database.
  const creatorProfile = await absentUntilMigrated(creatorDomain().creator.profileByParty(session.organizationId, record.partyId));
  const creatorHref = creatorProfile && resolveWorkspaceRole(session) === 'ADMIN' ? EMG_HREFS.creator(creatorProfile.id) : null;
  const CREATOR_ELSEWHERE = 'This person is a creator; their operating view opens in the Admin workspace.';
  const tabs = [
    { label: 'Overview', href: personHref(record.partyId), current: true },
    { label: 'Relationships', href: '#relationships' },
    { label: 'Outreach', href: '#outreach' },
    creatorHref
      ? { label: 'Opportunities', href: `${creatorHref}#commercial` }
      : { label: 'Opportunities', href: null, reason: creatorProfile ? CREATOR_ELSEWHERE : 'Opportunities are not listed per person yet. They are listed under CRM, Opportunities.' },
    creatorHref
      ? { label: 'Work', href: `${creatorHref}#content` }
      : { label: 'Work', href: null, reason: creatorProfile ? CREATOR_ELSEWHERE : 'Work is not linked to a person yet.' },
    { label: 'Intelligence', href: null, reason: 'Intelligence does not cover a person yet.' },
  ];

  return (
    <LoopPage label={subject.name}>
      <PageHead
        trail={[...trailBase, { label: subject.name }]}
        actions={
          <div className="loop-btnrow">
            <ActionButton action={{ label: '← Back to People', href: PEOPLE_HREF }} />
            {state === 'ESTABLISHED' ? (
              <ActionButton action={{ label: '+ Record relationship', href: `/crm/relationships/new?party=${encodeURIComponent(record.partyId)}&returnParty=${encodeURIComponent(record.partyId)}`, primary: true }} />
            ) : null}
          </div>
        }
      />
      <SubjectCard subject={subject} density="featured" headingLevel="h1" />

      {searchParams?.outcome === 'RELATIONSHIP_RECORDED' ? (
        <StateBlock kind="empty" compact title="Relationship recorded." body="This person is now linked to the commercial Relationship you just asserted." />
      ) : null}

      {state === 'SUPERSEDED' && view.current ? (
        <StateBlock
          kind="attention"
          title="This person was replaced by another record."
          body={`Their history is kept here unchanged. New work belongs on ${view.current.name ?? 'the current record'}.`}
          action={{ label: `Open ${view.current.name ?? 'the current record'}`, href: personHref(view.current.partyId) }}
        />
      ) : null}
      {state === 'ARCHIVED' ? (
        <StateBlock
          kind="empty"
          title="This person is archived."
          body="Their identity and history are kept. New commercial action is restricted."
        />
      ) : null}
      {state === 'NOT_ESTABLISHED' ? (
        <StateBlock
          kind="attention"
          title="Identity review required."
          body="This record is not an established person yet, so Loop does not treat it as one. Establishing it is a governed decision in identity review."
          action={{ label: 'Open identity review', href: '/crm/parties' }}
        />
      ) : null}

      <Panel title="Conversation summary">
        {outreach && outreach.outcome === 'OK' && outreach.conversationIntelligence ? (
          <>
            <p className="loop-panel__lead">{outreach.conversationIntelligence.summary}</p>
            <div className="loop-btnrow" style={{ marginTop: 10 }}>
              <span className="loop-pill loop-pill--info">
                AI suggests: {outreach.conversationIntelligence.suggestion === 'REPLY' ? 'Reply' : outreach.conversationIntelligence.suggestion === 'WAIT' ? 'Waiting on them' : outreach.conversationIntelligence.suggestion === 'CIRCLE_BACK' ? 'Circle back' : outreach.conversationIntelligence.suggestion === 'REVIEW' ? 'Review' : 'No immediate action'}
              </span>
              {outreach.conversationIntelligence.confidence ? <span className="loop-note">Confidence: {outreach.conversationIntelligence.confidence.toLowerCase()}</span> : null}
            </div>
            {outreach.conversationIntelligence.suggestionText ? <p className="loop-note" style={{ marginTop: 8 }}>{outreach.conversationIntelligence.suggestionText}</p> : null}
            {outreach.nextMeeting ? <p className="loop-note" style={{ marginTop: 8 }}>Calendar: next meeting {time.dateTime(outreach.nextMeeting.at)}{outreach.nextMeeting.title ? ` — ${outreach.nextMeeting.title}` : ''}.</p> : null}
            <p className="loop-note" style={{ marginTop: 8 }}>
              This is a private AI interpretation of your linked Gmail plus your calendar context. It can suggest a next move, but it does not silently change the CRM record.
            </p>
          </>
        ) : outreach && outreach.outcome === 'OK' ? (
          <>
            <p className="loop-panel__lead">
              {outreach.row.outreach.lastTouch ? `Last conversation touch: ${time.relative(outreach.row.outreach.lastTouch.at)}.` : 'No conversation touch is recorded.'}
              {outreach.nextMeeting ? ` Next meeting: ${time.dateTime(outreach.nextMeeting.at)}.` : ''}
            </p>
            <p className="loop-note">
              A body-aware AI summary will appear here when Mail content intelligence has been commissioned and authorized for this mailbox. Until then Loop uses Gmail and Calendar metadata only.
            </p>
          </>
        ) : (
          <p className="loop-note">Conversation intelligence is not available for this person.</p>
        )}
      </Panel>

      <ContextTabs label="Person sections" tabs={tabs} />

      <RecordLayout
        railLabel="Identity and context"
        main={
          <>
            <Panel title="What is happening now">
              {relationships.state !== 'OK' ? (
                <StateBlock
                  kind={relationships.state === 'NOT_AUTHORIZED' ? 'denied' : 'error'}
                  compact
                  title={relationships.state === 'NOT_AUTHORIZED' ? 'You cannot view relationships.' : 'Relationships could not be loaded.'}
                  body={
                    relationships.state === 'NOT_AUTHORIZED'
                      ? 'What is happening around this person depends on relationships you do not have access to.'
                      : 'This is a failure to read, not a finding that there are none.'
                  }
                />
              ) : context.activeCount ? (
                <p className="loop-panel__lead">
                  {subject.name} has {context.fact.text}
                  {context.relationship ? `, including ${context.relationship}` : ''}.
                </p>
              ) : (
                <p className="loop-panel__lead">No active relationship is recorded for {subject.name}.</p>
              )}
            </Panel>

            <OutreachNotice outcome={typeof searchParams?.outcome === 'string' ? searchParams.outcome : undefined} />
            {state === 'ESTABLISHED' ? <PersonOutreach read={outreach} time={time} /> : null}

            <section id="relationships" aria-label="Relationships">
              <Panel title="Relationships">
                {relationships.state === 'OK' ? (
                  relationships.value.length === 0 ? (
                    <StateBlock
                      kind="empty"
                      compact
                      title="No relationship recorded."
                      body="This person is established, but no commercial relationship has been asserted yet."
                      action={state === 'ESTABLISHED' ? { label: 'Record relationship', href: `/crm/relationships/new?party=${encodeURIComponent(record.partyId)}&returnParty=${encodeURIComponent(record.partyId)}` } : undefined}
                    />
                  ) : (
                    <div className="loop-cards">
                      {relationships.value.map((r) => (
                        <SubjectCard key={r.key} subject={r} density="card" />
                      ))}
                    </div>
                  )
                ) : (
                  <p className="loop-note">Not available.</p>
                )}
              </Panel>
            </section>
          </>
        }
        rail={
          <>
            <Panel title="Identity">
              <Facts
                rows={[
                  { label: 'Type', value: 'Person' },
                  { label: 'Identity', value: subject.state.label },
                  {
                    label: 'Established',
                    value: record.establishment.establishedAt ? time.date(record.establishment.establishedAt) : null,
                    unknownText: 'Not established',
                  },
                  {
                    label: 'Basis',
                    value: record.establishment.basis ? governedTerm(record.establishment.basis) : null,
                    unknownText: 'None recorded',
                  },
                  {
                    label: 'Established by',
                    value: record.establishment.establishedBy
                      ? record.establishment.establishedBy.displayName ?? 'A workspace member'
                      : null,
                    unknownText: 'Not recorded',
                  },
                  { label: 'Same-person check', value: governedTerm(record.posture.sameParty) },
                  { label: 'Email and phone', value: null, unknownText: 'Not part of a person record yet' },
                ]}
              />
              {record.posture.limitations.length > 0 ? (
                <ul className="loop-note" style={{ margin: '12px 0 0', paddingLeft: 18 }}>
                  {record.posture.limitations.map((l) => (
                    <li key={l}>{LIMITATION_TEXT[l] ?? governedTerm(l)}</li>
                  ))}
                </ul>
              ) : null}
            </Panel>

            <PersonContext read={outreach} time={time} />

            <Panel title="How Loop knows them">
              {activeLinks.length === 0 ? (
                <p className="loop-note">No intake record is linked to this person.</p>
              ) : (
                <ul className="loop-stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {activeLinks.map((link) => (
                    <li key={link.linkId} className="loop-note">
                      {canOpenIntake ? (
                        <Link href={`/crm/customers/${encodeURIComponent(link.customerId)}`}>Linked intake record</Link>
                      ) : (
                        'Linked intake record'
                      )}{' '}
                      · linked {time.date(link.linkedAt)} ({governedTerm(link.basis)})
                    </li>
                  ))}
                </ul>
              )}
              <p className="loop-note" style={{ marginTop: 10 }}>
                Intake records are evidence of how this person entered Loop. They are not the person.
              </p>
            </Panel>

            <Panel title="Contact points">
              <ContactPointList read={contactPoints} time={time} none="No contact point is recorded for this person." />
              <p className="loop-note" style={{ marginTop: 10 }}>
                Business contact details recorded for reaching this person. They are not identity evidence, and recording one
                does not verify it.
              </p>
            </Panel>

            <Panel title="Verification">
              <p className="loop-note">
                The temporary verification screen still holds the governed identity actions.{' '}
                <Link href={`/crm/parties/${encodeURIComponent(record.partyId)}`}>Open verification record</Link>
              </p>
            </Panel>

            {creatorProfile ? (
              <Panel title="Creator">
                <p className="loop-note">
                  {subject.name} has a creator profile{creatorProfile.handle ? ` (${creatorProfile.handle.startsWith('@') ? creatorProfile.handle : `@${creatorProfile.handle}`})` : ''}.{' '}
                  {creatorHref ? <Link href={creatorHref}>Open creator operations</Link> : CREATOR_ELSEWHERE}
                </p>
              </Panel>
            ) : null}
          </>
        }
      />
    </LoopPage>
  );
}
