// Shared step model for the workflow builders (Start Work + Workflow Template
// admin). Pure types + helpers, no React — safe to import from any component.
// One source of truth for what a step is and how it serialises for the server.

export type AssignMode = 'specific' | 'responsibility' | 'creator' | 'previous' | 'unassigned';
export type NoteMode = 'none' | 'optional' | 'required';

export interface Step {
  name: string;
  instruction: string;
  mode: AssignMode;
  specificUserId: string;
  responsibilityKey: string;
  completionConfirmation: string;
  completionNote: NoteMode;
  notifyActive: boolean;
  notifyComplete: boolean;
}

export const ASSIGN_LABELS: Record<AssignMode, string> = {
  specific: 'A specific team member',
  responsibility: 'A responsibility',
  creator: 'Whoever starts this work',
  previous: 'Whoever completed the previous step',
  unassigned: 'Leave unassigned',
};

const MODES: AssignMode[] = ['specific', 'responsibility', 'creator', 'previous', 'unassigned'];

export function emptyStep(name = ''): Step {
  return {
    name,
    instruction: '',
    mode: 'unassigned',
    specificUserId: '',
    responsibilityKey: '',
    completionConfirmation: '',
    completionNote: 'none',
    notifyActive: true,
    notifyComplete: false,
  };
}

// A step as it arrives from a saved template (server shape) → the editor model.
export interface TemplateStepShape {
  name: string;
  instruction: string;
  mode: string;
  specificUserId: string | null;
  responsibilityKey: string | null;
  completionConfirmation: string | null;
  completionNote: string;
  notifyActive: boolean;
  notifyComplete: boolean;
}

export function fromTemplateStep(t: TemplateStepShape): Step {
  const mode = MODES.includes(t.mode as AssignMode) ? (t.mode as AssignMode) : 'unassigned';
  const note = t.completionNote === 'optional' || t.completionNote === 'required' ? (t.completionNote as NoteMode) : 'none';
  return {
    name: t.name,
    instruction: t.instruction,
    mode,
    specificUserId: t.specificUserId ?? '',
    responsibilityKey: t.responsibilityKey ?? '',
    completionConfirmation: t.completionConfirmation ?? '',
    completionNote: note,
    notifyActive: t.notifyActive,
    notifyComplete: t.notifyComplete,
  };
}

// Serialise a step into the shape server actions read (coerceStep). Only carries
// the target relevant to the chosen mode.
export function serialiseStep(s: Step) {
  return {
    name: s.name,
    instruction: s.instruction,
    mode: s.mode,
    specificUserId: s.mode === 'specific' ? s.specificUserId : null,
    responsibilityKey: s.mode === 'responsibility' ? s.responsibilityKey : null,
    completionConfirmation: s.completionConfirmation.trim() || null,
    completionNote: s.completionNote,
    notifyActive: s.notifyActive,
    notifyComplete: s.notifyComplete,
  };
}
