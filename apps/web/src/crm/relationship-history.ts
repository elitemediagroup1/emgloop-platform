// A Relationship's own recorded history, as activity items (handoff 2026-09-16, p. 10).
//
// This is not Universal Activity: `ActivityService` has no RELATIONSHIP subject yet
// (activity.v1 reserves it). It is the Relationship authority's own event log, drawn
// with the shared activity item so the truth type and evidence read the same way
// everywhere. Lifecycle events are changes; details, owner and participant events are
// audit history. Nothing is added that the log did not record: reason text is never
// returned by the authority, so only whether a reason was recorded is shown.
//
// PURE.

import type { ActivityCategory, CrmRelationshipRecordV1 } from '@emgloop/shared';
import type { ActivityEntry } from '../app/app/_loop-os/activity-item';
import { governedTerm, sideName } from './subject-display';

const LIFECYCLE = new Set(['RELATIONSHIP_CREATED', 'RELATIONSHIP_ENDED', 'RELATIONSHIP_REACTIVATED', 'RELATIONSHIP_VOIDED']);

export function relationshipEventCategory(type: string): ActivityCategory {
  return LIFECYCLE.has(type) ? 'STATE_CHANGE' : 'AUDIT';
}

export interface HistoryClock {
  dateTime(value: string): string;
  iso(value: string): string;
}

export function relationshipHistoryEntries(
  record: Pick<CrmRelationshipRecordV1, 'relationshipId' | 'history' | 'participants'>,
  names: ReadonlyMap<string, string>,
  clock: HistoryClock,
): ActivityEntry[] {
  const participants = new Map(record.participants.map((p) => [p.participantId, p]));
  return [...record.history]
    .sort((a, b) => b.sequence - a.sequence)
    .map((event) => {
      const participant = event.participantId ? participants.get(event.participantId) ?? null : null;
      const who = participant ? sideName(participant.party, names) : null;
      const story = who
        ? `${governedTerm(event.type)}: ${who.name} (${governedTerm(participant!.role)})`
        : governedTerm(event.type);
      const change =
        event.fromState || event.toState
          ? `${event.fromState ? governedTerm(event.fromState) : 'None'} → ${event.toState ? governedTerm(event.toState) : 'None'}`
          : null;
      return {
        key: `${record.relationshipId}:${event.sequence}`,
        category: relationshipEventCategory(event.type),
        story,
        when: clock.dateTime(event.occurredAt),
        whenIso: clock.iso(event.occurredAt),
        evidence: [
          { label: 'Occurred', value: clock.dateTime(event.occurredAt) },
          { label: 'How the time is known', value: governedTerm(event.occurredAtBasis) },
          { label: 'Recorded', value: clock.dateTime(event.recordedAt) },
          { label: 'Recorded by', value: event.actorUserId ? 'A workspace member' : 'Loop' },
          { label: 'Change', value: change, unknownText: 'No state change' },
          { label: 'Reason', value: event.reasonRecorded ? 'Recorded (kept with the relationship)' : null, unknownText: 'None recorded' },
          { label: 'Participant', value: who ? who.name : null, unknownText: 'Not a participant event' },
          { label: 'Authority', value: 'Relationships' },
        ],
      } satisfies ActivityEntry;
    });
}

