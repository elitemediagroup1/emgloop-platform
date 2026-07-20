// Sprint 27D — Business Process Engine · PR B (State Projection)
// ---------------------------------------------------------------------------
// PURE, deterministic projection of current process/phase state from the
// append-only transition log. No I/O, no Prisma, no clock, no RNG. Given the same
// (definition, ordered transitions, archival flag) it ALWAYS returns the same
// RuntimeState — current state is a PROJECTION, never a stored duplicate.
//
// Constitutional decision #1 (frozen): the transition log is the sole source of
// truth. This module is the reader of that truth. It never mutates and never
// consults anything but the log + definition (+ the administrative archival flag,
// which has no transition kind and is layered on as an overlay — see below).
//
// The projected phase states are POSITION states derived from the log:
//   pending | active | exited | reopened | skipped
// The PR A phase states `satisfied` / `verified` are transient in-flight facts
// (Work Intelligence / Verification) that are NOT recorded as transitions and so
// are not projectable; a committed `forward`/`complete` already certifies that the
// phase it leaves was verified. (`skipped` is a valid position state the reducer
// honors; nothing in PR B SETS it — applicability evaluation is PR C/D.)
// ---------------------------------------------------------------------------

import {
  type BusinessProcessDefinition,
  type PhaseDefinition,
  type PhaseState,
  type ProcessState,
  type TransitionKind,
} from './business-process.contracts';

// A minimal, Prisma-independent view of a log row that the projection needs.
export interface TransitionLogEntry {
  sequence: number;
  kind: TransitionKind;
  fromPhaseKey?: string | null;
  toPhaseKey?: string | null;
}

export interface ProjectedPhase {
  phaseKey: string;
  position: number;
  state: PhaseState;
  reopenedCount: number;
}

export interface RuntimeState {
  // Business state projected purely from the log.
  processState: ProcessState;
  // Business state with the administrative archival overlay applied.
  effectiveState: ProcessState;
  currentPhaseKey: string | null;
  activePhaseKey: string | null; // the phase in `active`/`reopened`, else null
  completedPhaseKeys: string[]; // `exited`
  skippedPhaseKeys: string[];
  phases: ProjectedPhase[]; // every phase, ordered by position
  isTerminal: boolean;
  archived: boolean;
  transitionCount: number;
  lastSequence: number;
}

export interface ProjectionOptions {
  // Administrative retention flag from the instance row. NOT business state and
  // NOT derivable from the log — supplied by the repository. When set on a terminal
  // process, the effective state is `archived`.
  archivedAt?: Date | null;
}

const TERMINAL_BUSINESS_STATES: ReadonlySet<ProcessState> = new Set<ProcessState>([
  'completed',
  'abandoned',
]);

function orderedPhaseDefs(def: BusinessProcessDefinition): PhaseDefinition[] {
  return [...def.phases].sort((a, b) => a.position - b.position);
}

// Reset every non-skipped phase strictly after `position` back to `pending`.
// Regression/reopen invalidate all forward progress past the target.
function resetPhasesAfter(
  phases: Map<string, ProjectedPhase>,
  position: number,
): void {
  for (const p of phases.values()) {
    if (p.position > position && p.state !== 'skipped') {
      p.state = 'pending';
    }
  }
}

// ---------------------------------------------------------------------------
// projectState — replay the ordered log into current state. Deterministic.
// ---------------------------------------------------------------------------
export function projectState(
  definition: BusinessProcessDefinition,
  transitions: readonly TransitionLogEntry[],
  opts: ProjectionOptions = {},
): RuntimeState {
  const defs = orderedPhaseDefs(definition);
  const phases = new Map<string, ProjectedPhase>();
  for (const d of defs) {
    phases.set(d.key, { phaseKey: d.key, position: d.position, state: 'pending', reopenedCount: 0 });
  }
  const positionOf = (key: string | null | undefined): number =>
    (key != null ? phases.get(key)?.position : undefined) ?? -Infinity;

  let processState: ProcessState = 'draft';
  let currentPhaseKey: string | null = null;

  // Replay strictly in sequence order (defensive sort; the log is append-only).
  const ordered = [...transitions].sort((a, b) => a.sequence - b.sequence);
  for (const t of ordered) {
    switch (t.kind) {
      case 'forward': {
        if (currentPhaseKey != null) {
          const from = phases.get(currentPhaseKey);
          if (from) from.state = 'exited';
        }
        if (t.toPhaseKey != null) {
          const to = phases.get(t.toPhaseKey);
          if (to) to.state = 'active';
          currentPhaseKey = t.toPhaseKey;
        }
        processState = processState === 'draft' ? 'initiated' : 'active';
        break;
      }
      case 'backward': {
        if (t.toPhaseKey != null) {
          resetPhasesAfter(phases, positionOf(t.toPhaseKey));
          const to = phases.get(t.toPhaseKey);
          if (to) to.state = 'active';
          currentPhaseKey = t.toPhaseKey;
        }
        processState = 'active';
        break;
      }
      case 'reopen': {
        if (t.toPhaseKey != null) {
          resetPhasesAfter(phases, positionOf(t.toPhaseKey));
          const to = phases.get(t.toPhaseKey);
          if (to) {
            to.state = 'reopened';
            to.reopenedCount += 1;
          }
          currentPhaseKey = t.toPhaseKey;
        }
        processState = 'active';
        break;
      }
      case 'suspend':
        processState = 'on_hold';
        break;
      case 'resume':
        processState = 'active';
        break;
      case 'terminate':
        processState = 'abandoned';
        break;
      case 'restart': {
        // Reborn: reset all phase positions; the log preserves the prior attempt.
        for (const p of phases.values()) {
          p.state = 'pending';
          p.reopenedCount = 0;
        }
        currentPhaseKey = null;
        processState = 'draft';
        break;
      }
      case 'complete': {
        if (currentPhaseKey != null) {
          const cur = phases.get(currentPhaseKey);
          if (cur) cur.state = 'exited';
        }
        processState = 'completed';
        break;
      }
      default:
        // Unknown kind in the log: ignore rather than corrupt the projection.
        break;
    }
  }

  const archived = opts.archivedAt != null;
  const isTerminal = TERMINAL_BUSINESS_STATES.has(processState) || archived;
  const effectiveState: ProcessState = archived ? 'archived' : processState;

  const phaseList = [...phases.values()].sort((a, b) => a.position - b.position);
  const activePhaseKey =
    phaseList.find((p) => p.state === 'active' || p.state === 'reopened')?.phaseKey ?? null;

  return {
    processState,
    effectiveState,
    currentPhaseKey,
    activePhaseKey,
    completedPhaseKeys: phaseList.filter((p) => p.state === 'exited').map((p) => p.phaseKey),
    skippedPhaseKeys: phaseList.filter((p) => p.state === 'skipped').map((p) => p.phaseKey),
    phases: phaseList,
    isTerminal,
    archived,
    transitionCount: ordered.length,
    lastSequence: ordered.length > 0 ? ordered[ordered.length - 1]!.sequence : 0,
  };
}
