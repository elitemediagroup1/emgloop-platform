import { notFound } from 'next/navigation';
import type { BrainWorkDisplayState } from '@emgloop/shared';
import { hasValue } from '@emgloop/shared';
import { requirePermission } from '../../../../../auth/guard';
import { readAiControlFloor } from '../../../../../ai/ai-environment';
import { brainWork } from '../../../../../brain/brain-runtime';
import { crmSubjectReads, personHref, relationshipHref, RELATIONSHIPS_HREF } from '../../../../../crm/crm-slice-data';
import { readRelationshipView } from '../../../../../crm/crm-subject-reads';
import { relationshipHistoryEntries } from '../../../../../crm/relationship-history';
import { businessDate, crmPartyId, governedTerm, relationshipStateDisplay, sideName, subjectTypeLabel, type SubjectDisplay } from '../../../../../crm/subject-display';
import { requireCrmContext } from '../../../../../crm/crm-data';
import { viewerTime } from '../../../../../time/viewer-time';
import { ActivityList } from '../../../_loop-os/activity-item';
import { BrainWorkState } from '../../../_loop-os/brain-state';
import {
  ActionButton,
  ContextDrawer,
  ContextTabs,
  Facts,
  LxPage,
  PageHead,
  Panel,
  ReadFailed,
  RecordLayout,
  StateBlock,
  SummaryStrip,
} from '../../../_loop-os/record';
import { SubjectCard } from '../../../_loop-os/subject-card';

export const dynamic = 'force-dynamic';

// A Relationship record (handoff 2026-09-16, p. 8): the connection itself, operable
// without collapsing either Party.
//
// From the Relationships authority: kind (its own label), state, sides, participants
// and the recorded history. Participant roles and states have no approved display
// labels, so their governed values are shown as themselves. Accountability is a
// workspace user, not a participant, and is shown as such. Opportunities, Work and
// Universal Activity have no authority for a Relationship yet and say so.
//
// Governed acts (end, reactivate, void, participants) still live on the temporary
// verification screen; this page links there only when the viewer may act.
//
// Brain: RELATIONSHIP is a subject Brain may work on. The panel shows real state:
// not switched on while the AI floor is off, otherwise the unfinished work Loop
// records for this relationship, or that nothing is running.

async function brainStateFor(relationshipId: string): Promise<BrainWorkDisplayState | 'UNREADABLE'> {
  if (!readAiControlFloor().activation.enabled) return 'NOT_ENABLED';
  try {
    const ctx = await requireCrmContext();
    const truth = await brainWork().forSubject(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      { type: 'RELATIONSHIP', id: relationshipId },
    );
    if (!hasValue(truth)) return 'UNREADABLE';
    const phases = truth.value.map((w) => w.phase);
    if (phases.includes('WAITING_FOR_YOU')) return 'WAITING_FOR_YOU';
    if (phases.includes('WORKING')) return 'WORKING';
    if (phases.includes('QUEUED')) return 'QUEUED';
    return 'IDLE';
  } catch {
    return 'UNREADABLE';
  }
}

export default async function RelationshipPage({ params }: { params: { relationshipId: string } }) {
  await requirePermission('relationships', 'view');
  const view = await readRelationshipView(await crmSubjectReads(), params.relationshipId);
  const trailBase = [{ label: 'CRM' }, { label: 'Relationships', href: RELATIONSHIPS_HREF }];
  if (view.outcome !== 'OK') {
    if (view.outcome === 'NOT_FOUND') notFound();
    return (
      <LxPage label="Relationship">
        <PageHead trail={[...trailBase, { label: 'Relationship' }]} title="Relationship" />
        <ReadFailed what="this relationship" />
      </LxPage>
    );
  }

  const { record, subject, names, capabilities } = view;
  const time = viewerTime();
  const brainState = await brainStateFor(record.relationshipId);
  const activeParticipants = record.participants.filter((p) => p.state === 'ACTIVE');
  const firstEvent = [...record.history].sort((a, b) => a.sequence - b.sequence)[0] ?? null;
  const since = record.businessStartDate ? businessDate(record.businessStartDate) : firstEvent ? time.date(firstEvent.occurredAt) : null;
  const canManage =
    capabilities.endRelationship || capabilities.reactivateRelationship || capabilities.voidRelationship || capabilities.addParticipant;

  const participantSubject = (p: (typeof record.participants)[number]): SubjectDisplay => {
    const side = sideName(p.party, names);
    const id = crmPartyId(p.party);
    const range = [p.effectiveFrom ? `from ${time.date(p.effectiveFrom)}` : null, p.effectiveTo ? `to ${time.date(p.effectiveTo)}` : null]
      .filter(Boolean)
      .join(' ');
    return {
      kind: side.kind,
      key: p.participantId,
      name: side.name,
      named: side.named,
      typeLabel: subjectTypeLabel(side.kind),
      state: relationshipStateDisplay(p.state),
      context: `${governedTerm(p.role)}${p.side ? ' · a side of this relationship' : ''}`,
      affiliation: range || null,
      fact: null,
      action: side.kind === 'PERSON' && side.named && id ? { label: `Open ${side.name}`, href: personHref(id) } : null,
    };
  };

  return (
    <LxPage label={subject.name}>
      <PageHead
        trail={[...trailBase, { label: subject.name }]}
        actions={
          canManage ? (
            <ActionButton action={{ label: 'Manage relationship', href: `/crm/relationships/${encodeURIComponent(record.relationshipId)}` }} />
          ) : undefined
        }
      />
      <SubjectCard subject={subject} density="featured" headingLevel="h1" />

      {record.duplicates.length > 0 ? (
        <StateBlock
          kind="attention"
          title="Another relationship has the same parties."
          body="Loop found a relationship between the same people or companies. Check whether both should exist."
          action={{ label: 'Open the other relationship', href: relationshipHref(record.duplicates[0]!.relationshipId) }}
        />
      ) : null}

      <SummaryStrip
        label="Summary"
        items={[
          { label: 'Since', value: since, unknownText: 'Not recorded' },
          { label: 'Participants', value: `${activeParticipants.length} active` },
          { label: 'Opportunities', value: null, unknownText: 'Not tracked yet' },
          { label: 'Open work', value: null, unknownText: 'Not linked yet' },
        ]}
      />

      <ContextTabs
        label="Relationship sections"
        tabs={[
          { label: 'Overview', href: relationshipHref(record.relationshipId), current: true },
          { label: 'Participants', href: '#participants' },
          { label: 'History', href: '#history' },
          { label: 'Activity', href: null, reason: 'Universal Activity does not cover relationships yet.' },
          { label: 'Opportunities', href: null, reason: 'Opportunities are not tracked in Loop yet.' },
          { label: 'Work', href: null, reason: 'Work is not linked to relationships yet.' },
        ]}
      />

      <RecordLayout
        railLabel="Participants and current context"
        main={
          <>
            <Panel
              title="Status"
              lead={`${relationshipStateDisplay(record.state).label} ${record.kindLabel.toLowerCase()}${
                since ? ` since ${since}` : ''
              }, with ${activeParticipants.length === 1 ? '1 active participant' : `${activeParticipants.length} active participants`}.`}
            >
              {record.description ? <p className="lx-note">{record.description}</p> : null}
            </Panel>

            <section id="history" aria-label="History">
              <Panel title="Relationship history">
                {record.history.length === 0 ? (
                  <StateBlock kind="empty" compact title="No history recorded." body="Changes to this relationship appear here as they are recorded." />
                ) : (
                  <ActivityList label="Relationship history" entries={relationshipHistoryEntries(record, names, time)} />
                )}
                <p className="lx-note" style={{ marginTop: 10 }}>
                  From this relationship&apos;s own record. Calls, messages and other activity are not connected to relationships yet.
                </p>
              </Panel>
            </section>

            <Panel title="Intelligence">
              {brainState === 'UNREADABLE' ? (
                <StateBlock kind="error" compact title="Loop could not read Brain work for this relationship." body="This is a failure to read, not a finding that nothing is running." />
              ) : (
                <BrainWorkState state={brainState} title="Brain on this relationship" />
              )}
            </Panel>
          </>
        }
        rail={
          <>
            <section id="participants" aria-label="Participants">
              <Panel title="Participants">
                {record.participants.length === 0 ? (
                  <p className="lx-note">No participant is recorded.</p>
                ) : (
                  <div className="lx-stack">
                    {record.participants.map((p) => (
                      <SubjectCard key={p.participantId} subject={participantSubject(p)} density="context" />
                    ))}
                  </div>
                )}
              </Panel>
            </section>
            <Panel title="Current context">
              <Facts
                rows={[
                  { label: 'Kind', value: record.kindLabel },
                  { label: 'Structure', value: record.structure === 'OWN' ? `With ${view.workspaceName ?? 'this workspace'}` : 'Between two parties' },
                  { label: 'State', value: relationshipStateDisplay(record.state).label },
                  { label: 'Started', value: record.businessStartDate ? businessDate(record.businessStartDate) : null, unknownText: 'Not recorded' },
                  { label: 'Ended', value: record.businessEndDate ? businessDate(record.businessEndDate) : null, unknownText: record.state === 'ACTIVE' ? 'Ongoing' : 'Not recorded' },
                  { label: 'Accountable', value: record.ownerUserId ? 'A workspace member' : null, unknownText: 'Nobody assigned' },
                  { label: 'Recorded', value: time.date(record.createdAt) },
                ]}
              />
            </Panel>
            <ContextDrawer summary="About these labels">
              <p className="lx-note">
                The kind is the Relationships authority&apos;s own label. Participant roles and states are shown as
                Loop records them; display names for them have not been decided yet.
              </p>
            </ContextDrawer>
          </>
        }
      />
    </LxPage>
  );
}
