// Phase 1 timeline primitives — reusable server components for rendering
// operational activity, interactions, state changes, and audit events with
// one coherent visual language while retaining source/type/provenance.

import type { ReactNode } from 'react';
import { interactionActorType, interactionActorName } from '@emgloop/database';
import { relTime } from '../app/app/_loop-os/format';

// ---------------------------------------------------------------------------
// Unified entry type
// ---------------------------------------------------------------------------

export type TimelineSource = 'interaction' | 'audit' | 'state-change' | 'event';

export interface TimelineEntry {
  id: string;
  source: TimelineSource;
  title: string;
  body?: string;
  actor: string;
  actorType: string;
  channel?: string;
  direction?: string;
  kind?: string;
  occurredAt: string;
  entityType?: string;
  entityId?: string;
  href?: string;
  badgeColor?: string;
}

// ---------------------------------------------------------------------------
// Adapters — repository types → TimelineEntry
// ---------------------------------------------------------------------------

export function fromInboxItem(item: {
  id: string;
  customerName: string;
  kind: string;
  channel: string;
  direction: string;
  summary: string;
  actorType: string;
  occurredAt: string;
}): TimelineEntry {
  return {
    id: item.id,
    source: 'interaction',
    title: item.customerName,
    body: item.summary !== item.kind ? item.summary : undefined,
    // The person is the subject, not necessarily the actor: an outbound SMS
    // sent by an AI employee must not read as though the customer sent it.
    actor: ACTOR_TYPE_LABELS[item.actorType] ?? item.actorType,
    actorType: item.actorType,
    channel: item.channel,
    direction: item.direction,
    kind: item.kind,
    occurredAt: item.occurredAt,
  };
}

export function fromAuditView(item: {
  id: string;
  action: string;
  actorType: string;
  actorName: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
}): TimelineEntry {
  const desc = item.action.replace(/\./g, ' ');
  return {
    id: item.id,
    source: 'audit',
    title: desc + (item.entityType ? ' on ' + item.entityType : ''),
    actor: item.actorName,
    actorType: item.actorType,
    kind: item.action.split('.')[0],
    occurredAt: item.createdAt,
    entityType: item.entityType ?? undefined,
    entityId: item.entityId ?? undefined,
  };
}

export function fromCustomerActivity(item: {
  id: string;
  kind: 'audit' | 'event';
  label: string;
  actor: string;
  at: string;
}): TimelineEntry {
  return {
    id: item.id,
    source: item.kind === 'audit' ? 'audit' : 'event',
    title: item.label.replace(/\./g, ' '),
    actor: item.actor,
    actorType: 'SYSTEM',
    kind: item.label.split('.')[0],
    occurredAt: item.at,
  };
}

export function fromInteraction(item: {
  id: string;
  kind: string;
  channel: string;
  direction: string;
  summary: string | null;
  occurredAt: Date | string;
  payload?: unknown;
}, opts?: { badgeColor?: string }): TimelineEntry {
  const payload = (item.payload && typeof item.payload === 'object')
    ? item.payload as Record<string, unknown>
    : {};
  const actorType = interactionActorType(item.payload) ?? 'SYSTEM';
  const actorName = interactionActorName(item.payload);
  const body = typeof payload.body === 'string' ? payload.body : undefined;
  const iso = typeof item.occurredAt === 'string'
    ? item.occurredAt
    : item.occurredAt.toISOString();
  return {
    id: item.id,
    source: 'interaction',
    title: item.summary || item.kind,
    body,
    actor: actorName ?? ACTOR_TYPE_LABELS[actorType] ?? actorType,
    actorType,
    channel: item.channel,
    direction: item.direction,
    kind: item.kind,
    occurredAt: iso,
    badgeColor: opts?.badgeColor,
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<TimelineSource, string> = {
  interaction: 'Interaction',
  audit: 'Audit',
  'state-change': 'State Change',
  event: 'Domain Event',
};

const ACTOR_TYPE_LABELS: Record<string, string> = {
  HUMAN_AGENT: 'Human',
  AI_AGENT: 'AI',
  AI_EMPLOYEE: 'AI',
  SYSTEM: 'System',
  CUSTOMER: 'Customer',
};

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export function Timeline({ children }: { children: ReactNode }) {
  // role="list" restores list semantics that Safari drops under list-style: none.
  return <ul className="tl" role="list">{children}</ul>;
}

export function TimelineItem({ entry }: { entry: TimelineEntry }) {
  return (
    <li className="tl-item">
      <ActivityTypeBadge
        source={entry.source}
        direction={entry.direction}
        color={entry.badgeColor}
      />
      <div className="tl-content">
        <div className="tl-title">{entry.title}</div>
        {entry.body ? <div className="tl-body">{entry.body}</div> : null}
        <div className="tl-meta">
          <ActorDisplay name={entry.actor} type={entry.actorType} />
          {entry.channel ? (
            <>
              <span className="tl-dot" aria-hidden="true">·</span>
              <span>{entry.channel}</span>
            </>
          ) : null}
          <span className="tl-dot" aria-hidden="true">·</span>
          <ProvenanceDisplay source={entry.source} />
          <span className="tl-dot" aria-hidden="true">·</span>
          <Timestamp iso={entry.occurredAt} />
        </div>
      </div>
    </li>
  );
}

export function ActivityTypeBadge({
  source,
  direction,
  color,
}: {
  source: TimelineSource;
  direction?: string;
  color?: string;
}) {
  // Decorative: every row already states its provenance in text.
  if (color) {
    return (
      <span
        className="tl-badge"
        style={{ background: color }}
        aria-hidden="true"
      />
    );
  }
  let modifier = '';
  if (source === 'interaction' && direction === 'inbound') modifier = ' tl-badge--in';
  else if (source === 'interaction' && direction === 'outbound') modifier = ' tl-badge--out';
  else if (source === 'audit') modifier = ' tl-badge--audit';
  else if (source === 'state-change') modifier = ' tl-badge--state';
  else if (source === 'event') modifier = ' tl-badge--event';

  return <span className={'tl-badge' + modifier} aria-hidden="true" />;
}

export function ActorDisplay({ name, type }: { name: string; type: string }) {
  const typeLabel = type ? ACTOR_TYPE_LABELS[type] ?? type : '';
  const showType = typeLabel !== '' && typeLabel.toLowerCase() !== name.toLowerCase();
  return (
    <span className="tl-actor">
      <span className="tl-actor__name">{name}</span>
      {showType ? <span className="tl-actor__type">{typeLabel}</span> : null}
    </span>
  );
}

export function ProvenanceDisplay({ source }: { source: TimelineSource }) {
  return (
    <span className="tl-provenance">{SOURCE_LABELS[source] ?? source}</span>
  );
}

export function Timestamp({ iso }: { iso: string }) {
  return (
    <time
      className="tl-time"
      dateTime={iso}
      title={new Date(iso).toLocaleString()}
    >
      {relTime(iso)}
    </time>
  );
}

export function EmptyTimeline({ message }: { message?: string }) {
  return (
    <div className="tl-empty">
      <div className="tl-empty__icon" aria-hidden="true">⚡</div>
      <div className="tl-empty__text">
        {message ?? 'No activity yet.'}
      </div>
    </div>
  );
}

export function AuditEventRow({ entry }: { entry: TimelineEntry }) {
  return (
    <li className="tl-item tl-item--audit">
      <ActivityTypeBadge source="audit" />
      <div className="tl-content">
        <div className="tl-title">{entry.title}</div>
        <div className="tl-meta">
          <ActorDisplay name={entry.actor} type={entry.actorType} />
          <span className="tl-dot" aria-hidden="true">·</span>
          <ProvenanceDisplay source="audit" />
          <span className="tl-dot" aria-hidden="true">·</span>
          <Timestamp iso={entry.occurredAt} />
        </div>
      </div>
    </li>
  );
}
