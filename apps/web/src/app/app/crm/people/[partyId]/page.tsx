import Link from 'next/link';
import { notFound } from 'next/navigation';
import { hasPermission, requirePermission } from '../../../../../auth/guard';
import { crmSubjectReads, personHref, PEOPLE_HREF, relationshipHref } from '../../../../../crm/crm-slice-data';
import { readPersonView } from '../../../../../crm/crm-subject-reads';
import { governedTerm, partyIdentityState } from '../../../../../crm/subject-display';
import { viewerTime } from '../../../../../time/viewer-time';
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
  SummaryStrip,
  type ActionSpec,
} from '../../../_loop-os/record';
import { SubjectCard } from '../../../_loop-os/subject-card';

export const dynamic = 'force-dynamic';

// A Person record (handoff 2026-09-16, pp. 6-7): who the person is, how Loop knows
// them, their relationship context and what is happening around them.
//
// REAL DATA ONLY. Identity comes from PartyRecordService, context from the
// Relationships authority. What no authority answers yet is said, never filled:
//   - Email, Call and Message: a Party has no governed communication channel, so
//     the actions are shown as unavailable and do nothing.
//   - Opportunities, Campaigns and open Work: no authority links them to a Party.
//   - Activity and Intelligence: no Party subject exists in either yet.
// States: Established; Identity review required; Superseded (points to the current
// person, history kept); Archived (history kept, new commercial action restricted).
// A missing, foreign or non-person id is not found.

const NO_CHANNEL = 'Loop has no governed communication channel for a person yet.';

const LIMITATION_TEXT: Record<string, string> = {
  EVIDENCE_NOT_COLLECTED: 'No identity evidence is collected yet: establishment is a decision a person made, not a verification.',
  VERIFICATION_NOT_AVAILABLE: 'No contact detail has a recorded verification.',
};

export default async function PersonPage({ params }: { params: { partyId: string } }) {
  await requirePermission('identityResolution', 'view');
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

  const channel = (label: string): ActionSpec => ({ label, href: null, reason: NO_CHANNEL });
  const tabs = [
    { label: 'Overview', href: personHref(record.partyId), current: true },
    { label: 'Relationships', href: '#relationships' },
    { label: 'Activity', href: null, reason: 'Activity is not projected onto a person yet.' },
    { label: 'Opportunities', href: null, reason: 'Opportunities are not tracked in Loop yet.' },
    { label: 'Work', href: null, reason: 'Work is not linked to a person yet.' },
    { label: 'Intelligence', href: null, reason: 'Intelligence does not cover a person yet.' },
  ];

  return (
    <LoopPage label={subject.name}>
      <PageHead
        trail={[...trailBase, { label: subject.name }]}
        actions={
          <div className="loop-btnrow">
            <ActionButton action={channel('Email')} />
            <ActionButton action={channel('Call')} />
            <ActionButton action={channel('Message')} />
          </div>
        }
      />
      <SubjectCard subject={subject} density="featured" headingLevel="h1" />

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

      <SummaryStrip
        label="Summary"
        items={[
          {
            label: 'Relationships',
            value: context.activeCount === null ? null : `${context.activeCount} active`,
            unknownText: 'Not available to you',
          },
          { label: 'Opportunities', value: null, unknownText: 'Not tracked yet' },
          { label: 'Campaigns', value: null, unknownText: 'Not tracked yet' },
          { label: 'Open work', value: null, unknownText: 'Not linked yet' },
        ]}
      />

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
              <StateBlock
                kind="unavailable"
                compact
                title="Activity for a person is not connected yet."
                body="Loop does not project calls, messages or changes onto a person yet, so none are shown here. This does not mean nothing happened."
              />
            </Panel>

            <section id="relationships" aria-label="Relationships">
              <Panel title="Relationships">
                {relationships.state === 'OK' ? (
                  relationships.value.length === 0 ? (
                    <StateBlock kind="empty" compact title="No relationship recorded." body="Relationships appear here once one is recorded for this person." />
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

            <Panel title="Verification">
              <p className="loop-note">
                The temporary verification screen still holds the governed identity actions.{' '}
                <Link href={`/crm/parties/${encodeURIComponent(record.partyId)}`}>Open verification record</Link>
              </p>
            </Panel>
          </>
        }
      />
    </LoopPage>
  );
}
