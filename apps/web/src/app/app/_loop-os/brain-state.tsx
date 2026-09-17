// Brain work on a subject, in one of its shared visual states.
//
// Idle, working (queued or running), waiting for the person, finished, did not
// finish, stopped, and not switched on. The words come from the one dictionary
// (`brainWorkLabel`, @emgloop/shared); this decides only how they look.
//
// PROVIDER-NEUTRAL. Nothing here names a provider or a model: which one served a
// call belongs to provenance and diagnostics. A finished job is not accepted truth:
// the boundary line says who decides.
//
// It never starts, answers or cancels anything itself. The actions it offers are
// links to places that do, passed in by a page that holds the authority.

import type { ReactNode } from 'react';
import { BRAIN_END_REASON_LANGUAGE, brainWorkLabel, type BrainWorkDisplayState } from '@emgloop/shared';
import { StatePill, type ActionSpec, ActionButton } from './record';
import type { SubjectTone } from '../../../crm/subject-display';

const LOOK: Record<BrainWorkDisplayState, { cls: string; mark: string; tone: SubjectTone }> = {
  NOT_ENABLED: { cls: 'not-enabled', mark: '⏻', tone: 'attention' },
  IDLE: { cls: 'idle', mark: '○', tone: 'neutral' },
  QUEUED: { cls: 'working', mark: '◷', tone: 'neutral' },
  WORKING: { cls: 'working', mark: '◐', tone: 'neutral' },
  WAITING_FOR_YOU: { cls: 'waiting', mark: '?', tone: 'attention' },
  COMPLETED: { cls: 'completed', mark: '✓', tone: 'good' },
  FAILED: { cls: 'failed', mark: '!', tone: 'critical' },
  CANCELLED: { cls: 'cancelled', mark: '■', tone: 'neutral' },
};

export function BrainWorkState(props: {
  state: BrainWorkDisplayState;
  /** What the work is, in product words ("Case explanation"). */
  title: string;
  /** The governed end reason, for FAILED and CANCELLED. */
  endReason?: string | null;
  /** Progress without a percentage: steps finished so far. */
  completedSteps?: number | null;
  action?: ActionSpec;
  children?: ReactNode;
}) {
  const label = brainWorkLabel(props.state);
  const look = LOOK[props.state];
  const reason = props.endReason ? BRAIN_END_REASON_LANGUAGE[props.endReason] ?? null : null;
  const working = props.state === 'QUEUED' || props.state === 'WORKING';
  return (
    <section
      className={`lx-brain lx-brain--${look.cls}`}
      aria-label={`${props.title}: ${label.label}`}
      aria-live={working ? 'polite' : undefined}
      data-brain-state={props.state}
    >
      <span className="lx-brain__mark" aria-hidden="true">
        <span>{look.mark}</span>
      </span>
      <div className="lx-brain__body">
        <div className="lx-brain__head">
          <p className="lx-brain__title">{props.title}</p>
          <StatePill state={{ label: label.label, tone: look.tone }} />
        </div>
        <p className="lx-brain__detail">{label.detail}</p>
        {reason ? <p className="lx-brain__meta">{reason}</p> : null}
        {working && typeof props.completedSteps === 'number' ? (
          <p className="lx-brain__meta">
            {props.completedSteps === 1 ? '1 step finished' : `${props.completedSteps} steps finished`}
          </p>
        ) : null}
        {props.children}
        {props.action ? (
          <div className="lx-btnrow" style={{ marginTop: 8 }}>
            <ActionButton action={props.action} />
          </div>
        ) : null}
        <p className="lx-brain__boundary">
          Brain explains, summarizes and drafts. It does not establish facts or make decisions: people and
          the parts of Loop that own a record do.
        </p>
      </div>
    </section>
  );
}
