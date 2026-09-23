// Creator Hub vocabulary and the pure projections both seats read (2026-09-22).
//
// ONE BUSINESS, TWO SEATS, THE SAME ROWS. The creator and EMG look at the same
// Content, Versions, Work and commercial records through two authorized
// projections. Everything in this file is PURE: the words both seats use, and
// the derivations that turn rows into a state -- no clock, no I/O, no store.
//
// THE FIVE SEPARATE EVENTS (product ruling, 2026-09-22). Creator approval,
// creative finality, production completion, publication and deliverable
// completion are DIFFERENT events, and nothing here collapses them: a version
// approved by the creator is not final until every requirement on it is met,
// and a deliverable is not complete until every requirement it declares --
// including publication, when it declares it -- is met.

// --- Vocabulary -----------------------------------------------------------------------------

export const CONTENT_KINDS = ['VIDEO', 'PHOTO'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export const VERSION_KINDS = ['ORIGINAL', 'EDIT'] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];

export const UPLOAD_STATES = ['PENDING', 'READY', 'FAILED'] as const;
export type UploadState = (typeof UPLOAD_STATES)[number];

/** Who may satisfy an approval requirement on a version. */
export const APPROVER_KINDS = ['CREATOR', 'EMG', 'BRAND_RELAYED'] as const;
export type ApproverKind = (typeof APPROVER_KINDS)[number];

/** A deliverable's requirement keys: three approvals and publication. */
export const DELIVERABLE_REQUIREMENT_KEYS = ['creator', 'emg', 'brand', 'published'] as const;
export type DeliverableRequirementKey = (typeof DELIVERABLE_REQUIREMENT_KEYS)[number];
/** The requirement keys an approval mark can carry (publication is a mark of its own). */
export const APPROVAL_REQUIREMENT_KEYS = ['creator', 'emg', 'brand'] as const;
export type ApprovalRequirementKey = (typeof APPROVAL_REQUIREMENT_KEYS)[number];

export const INSTRUCTION_ORIGINATORS = ['CREATOR', 'EMG', 'BRAND_RELAYED'] as const;
export type InstructionOriginator = (typeof INSTRUCTION_ORIGINATORS)[number];

export const NOTE_KINDS = ['CHANGE', 'KEEP'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** The creator-facing lifecycle of a piece of content (Mockup #1, eight states). */
export const CONTENT_STATES = [
  'RAW',
  'IN_PRODUCTION',
  'YOUR_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED_BY_YOU',
  'FINAL',
  'PUBLISHED',
] as const;
export type ContentState = (typeof CONTENT_STATES)[number];

export const CONTENT_STATE_LABELS: Record<ContentState, string> = {
  RAW: 'Raw upload',
  IN_PRODUCTION: 'In production',
  YOUR_REVIEW: 'Ready for your review',
  CHANGES_REQUESTED: 'Changes requested',
  APPROVED_BY_YOU: 'Approved by you',
  FINAL: 'Final',
  PUBLISHED: 'Published',
};

export const OPPORTUNITY_CATEGORIES = ['OPEN', 'CLOSED_WON', 'CLOSED_LOST'] as const;
export type OpportunityCategory = (typeof OPPORTUNITY_CATEGORIES)[number];

/** The creator-visible vocabulary for an Opportunity, designated by EMG per record. */
export const CREATOR_VISIBLE_OPPORTUNITY_STATES = ['BRAND_INTEREST', 'PITCHING', 'NEGOTIATING', 'CONFIRMED', 'DIDNT_GO_AHEAD'] as const;
export type CreatorVisibleOpportunityState = (typeof CREATOR_VISIBLE_OPPORTUNITY_STATES)[number];
export const CREATOR_VISIBLE_OPPORTUNITY_LABELS: Record<CreatorVisibleOpportunityState, string> = {
  BRAND_INTEREST: 'Brand interest',
  PITCHING: 'Pitching',
  NEGOTIATING: 'Negotiating',
  CONFIRMED: 'Confirmed',
  DIDNT_GO_AHEAD: "Didn't go ahead",
};

export const CAMPAIGN_STATES = ['DRAFT', 'AGREED', 'ACTIVE', 'PAUSED', 'ENDED', 'CANCELLED'] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export const DELIVERABLE_TYPES = ['REEL', 'VIDEO', 'PHOTO', 'STORY', 'OTHER'] as const;
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number];

export const COMPENSATION_STATES = ['EXPECTED', 'PENDING', 'RECEIVED_BY_EMG', 'AVAILABLE', 'TRANSFER_PENDING', 'PAID'] as const;
export type CompensationState = (typeof COMPENSATION_STATES)[number];
export const COMPENSATION_STATE_LABELS: Record<CompensationState, string> = {
  EXPECTED: 'Expected',
  PENDING: 'Pending',
  RECEIVED_BY_EMG: 'Received by EMG',
  AVAILABLE: 'Available to you',
  TRANSFER_PENDING: 'Transfer pending',
  PAID: 'Paid',
};
/** The ONE state whose amount a creator can act on. Everything else is "not yet payable". */
export const PAYABLE_COMPENSATION_STATE: CompensationState = 'AVAILABLE';

/** Where a piece of evidence came from. SEEDED_DEMO is labelled wherever it appears. */
export const EVIDENCE_SOURCES = ['PLATFORM', 'SEEDED_DEMO'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];
export const EVIDENCE_SOURCE_LABELS: Record<EvidenceSource, string> = {
  PLATFORM: 'from the platform',
  SEEDED_DEMO: 'seeded demo data',
};

export const SOCIAL_PLATFORMS = ['INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'FACEBOOK'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatform, string> = {
  INSTAGRAM: 'Instagram',
  TIKTOK: 'TikTok',
  YOUTUBE: 'YouTube',
  FACEBOOK: 'Facebook',
};

/** The Work OS step names a Production uses. The round is part of the name so the step list reads. */
export const PRODUCTION_STEP_EDIT = 'Edit';
export const PRODUCTION_STEP_REVIEW = 'Creator review';
export function productionStepName(base: string, round: number): string {
  return round <= 1 ? base : `${base} · round ${round}`;
}
export const PRODUCTION_WORK_TYPE_KEY = 'creator-production';
export const PRODUCTION_WORK_TYPE_NAME = 'Creator production';

// --- Notes and instruction sets --------------------------------------------------------------

export interface InstructionNote {
  readonly id: string;
  /** The moment the note points at, in seconds from the start of the version it was made on. */
  readonly atSeconds: number;
  /** An optional range end. */
  readonly untilSeconds?: number | null;
  readonly kind: NoteKind;
  readonly text: string;
}

export interface AddressedNote {
  readonly noteId: string;
  readonly addressed: boolean;
  readonly reply: string | null;
}

export const INSTRUCTION_LIMITS = Object.freeze({
  maxNotes: 40,
  maxNoteChars: 500,
  maxSummaryChars: 2000,
} as const);

export type NoteRefusal = 'NO_NOTES' | 'TOO_MANY_NOTES' | 'BAD_TIMESTAMP' | 'BAD_RANGE' | 'EMPTY_TEXT' | 'TEXT_TOO_LONG' | 'BAD_KIND' | 'DUPLICATE_ID';

/** Validate a draft note set before it becomes a durable instruction. Pure; fail closed. */
export function validateNotes(notes: readonly unknown[], durationSeconds?: number | null): { ok: true; notes: InstructionNote[] } | { ok: false; refusals: NoteRefusal[] } {
  const refusals: NoteRefusal[] = [];
  const out: InstructionNote[] = [];
  const ids = new Set<string>();
  if (notes.length > INSTRUCTION_LIMITS.maxNotes) refusals.push('TOO_MANY_NOTES');
  for (const raw of notes) {
    const n = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = typeof n.id === 'string' && n.id.trim() !== '' ? n.id.trim() : null;
    const at = typeof n.atSeconds === 'number' ? n.atSeconds : Number.NaN;
    const until = n.untilSeconds === undefined || n.untilSeconds === null ? null : typeof n.untilSeconds === 'number' ? n.untilSeconds : Number.NaN;
    const kind = n.kind === 'CHANGE' || n.kind === 'KEEP' ? n.kind : null;
    const text = typeof n.text === 'string' ? n.text.trim() : '';
    if (!id || ids.has(id)) refusals.push('DUPLICATE_ID');
    else ids.add(id);
    if (!Number.isFinite(at) || at < 0 || (typeof durationSeconds === 'number' && durationSeconds > 0 && at > durationSeconds + 1)) refusals.push('BAD_TIMESTAMP');
    if (until !== null && (!Number.isFinite(until) || until < at)) refusals.push('BAD_RANGE');
    if (!kind) refusals.push('BAD_KIND');
    if (text === '') refusals.push('EMPTY_TEXT');
    if (text.length > INSTRUCTION_LIMITS.maxNoteChars) refusals.push('TEXT_TOO_LONG');
    if (id && kind && text !== '' && Number.isFinite(at)) {
      out.push({ id, atSeconds: Math.round(at * 10) / 10, untilSeconds: until, kind, text });
    }
  }
  if (refusals.length > 0) return { ok: false, refusals: [...new Set(refusals)] };
  return { ok: true, notes: out.sort((a, b) => a.atSeconds - b.atSeconds) };
}

/** mm:ss for a note timestamp. */
export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// --- Requirements and state derivation ------------------------------------------------------

export interface DeliverableRequirement {
  readonly key: DeliverableRequirementKey;
  readonly label: string;
  readonly required: boolean;
}

/** The default requirement set for a campaign deliverable when none is declared. */
export const DEFAULT_DELIVERABLE_REQUIREMENTS: readonly DeliverableRequirement[] = Object.freeze([
  { key: 'creator', label: 'Your approval', required: true },
  { key: 'emg', label: 'EMG approval', required: true },
  { key: 'published', label: 'Published', required: true },
]);

/** Independent content: only the creator's own approval and publication matter, and neither is owed. */
export const INDEPENDENT_REQUIREMENTS: readonly DeliverableRequirement[] = Object.freeze([
  { key: 'creator', label: 'Your approval', required: true },
]);

export function readRequirements(raw: unknown): DeliverableRequirement[] {
  if (!Array.isArray(raw)) return [];
  const out: DeliverableRequirement[] = [];
  for (const r of raw) {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const key = typeof o.key === 'string' && (DELIVERABLE_REQUIREMENT_KEYS as readonly string[]).includes(o.key) ? (o.key as DeliverableRequirementKey) : null;
    if (!key) continue;
    out.push({ key, label: typeof o.label === 'string' && o.label ? o.label : key, required: o.required !== false });
  }
  return out;
}

export interface RequirementStatus extends DeliverableRequirement {
  readonly met: boolean;
  /** Who satisfied it, for which version, when -- when it is met. */
  readonly by: string | null;
  readonly versionLabel: string | null;
  readonly at: string | null;
}

export interface VersionMarks {
  readonly versionId: string;
  readonly label: string;
  readonly number: number;
  readonly uploadState: UploadState;
  readonly kind: VersionKind;
  readonly visibleToCreator: boolean;
  readonly createdAt: string;
  readonly approvals: readonly { requirementKey: ApprovalRequirementKey; approverKind: ApproverKind; by: string; at: string }[];
  readonly published: readonly { platform: string; at: string }[];
}

export interface ProductionFacts {
  readonly number: number;
  readonly workStatus: 'active' | 'completed' | 'cancelled';
  /** The current step the work is on, when active. */
  readonly currentStep: { kind: 'EDIT' | 'REVIEW'; round: number; status: string } | null;
}

export interface ContentStateInput {
  readonly versions: readonly VersionMarks[];
  readonly productions: readonly ProductionFacts[];
  readonly requirements: readonly DeliverableRequirement[];
}

/**
 * The creator-facing state of a piece of content, derived from its rows.
 *
 * ORDER OF PRECEDENCE, and why:
 *   PUBLISHED        a version carries a publication mark -- the world has it.
 *   FINAL            the latest visible version carries every required approval.
 *   APPROVED_BY_YOU  the creator approved the latest visible version, but a requirement remains.
 *   CHANGES_REQUESTED / IN_PRODUCTION / YOUR_REVIEW  from the active production's current step.
 *   RAW              nothing of the above.
 */
export function deriveContentState(input: ContentStateInput): ContentState {
  const visible = input.versions.filter((v) => v.visibleToCreator && v.uploadState === 'READY');
  if (visible.some((v) => v.published.length > 0)) return 'PUBLISHED';
  const latest = [...visible].sort((a, b) => b.number - a.number)[0] ?? null;
  const active = input.productions.find((p) => p.workStatus === 'active') ?? null;
  if (active?.currentStep) {
    if (active.currentStep.kind === 'REVIEW') return 'YOUR_REVIEW';
    return active.currentStep.round > 1 ? 'CHANGES_REQUESTED' : 'IN_PRODUCTION';
  }
  if (latest) {
    const required = input.requirements.filter((r) => r.required && r.key !== 'published').map((r) => r.key);
    const held = new Set(latest.approvals.map((a) => a.requirementKey));
    const creatorApproved = held.has('creator');
    const allMet = required.length > 0 && required.every((k) => held.has(k as ApprovalRequirementKey));
    if (allMet) return 'FINAL';
    if (creatorApproved) return 'APPROVED_BY_YOU';
  }
  return 'RAW';
}

/** The requirement checklist for a deliverable (or for independent content), against the version it is judged on. */
export function requirementStatuses(
  requirements: readonly DeliverableRequirement[],
  version: VersionMarks | null,
  approverLabels: (approval: { approverKind: ApproverKind; by: string }) => string,
): RequirementStatus[] {
  return requirements.map((r) => {
    if (!version) return { ...r, met: false, by: null, versionLabel: null, at: null };
    if (r.key === 'published') {
      const p = version.published[0] ?? null;
      return { ...r, met: p !== null, by: p ? p.platform : null, versionLabel: p ? version.label : null, at: p ? p.at : null };
    }
    const a = version.approvals.find((x) => x.requirementKey === r.key) ?? null;
    return { ...r, met: a !== null, by: a ? approverLabels(a) : null, versionLabel: a ? version.label : null, at: a ? a.at : null };
  });
}

/** A deliverable is complete only when every required requirement is met on ONE version. */
export function deliverableComplete(statuses: readonly RequirementStatus[]): boolean {
  const required = statuses.filter((s) => s.required);
  return required.length > 0 && required.every((s) => s.met);
}

/** The creator-facing deliverable line (Mockup #1 revision 2). */
export function deliverableLine(state: ContentState, complete: boolean): string {
  if (complete) return 'Complete';
  switch (state) {
    case 'RAW':
      return 'awaiting content';
    case 'IN_PRODUCTION':
      return 'in production';
    case 'CHANGES_REQUESTED':
      return 'in production again';
    case 'YOUR_REVIEW':
      return 'awaiting your approval';
    case 'APPROVED_BY_YOU':
      return 'Content approved';
    case 'FINAL':
      return 'Final approved';
    case 'PUBLISHED':
      return 'published';
  }
}

/** Which actions the record offers the creator, derived from state and context -- never invented by a page. */
export interface CreatorActions {
  readonly requestEdit: boolean;
  readonly submitOriginalForApproval: boolean;
  readonly publishAsIs: boolean;
  readonly review: boolean;
  readonly markPublished: boolean;
}

export function creatorActionsFor(input: { state: ContentState; hasDeliverable: boolean; acceptsUnedited: boolean; hasReadyOriginal: boolean }): CreatorActions {
  const { state, hasDeliverable, acceptsUnedited, hasReadyOriginal } = input;
  const idle = state === 'RAW' || state === 'APPROVED_BY_YOU' || state === 'FINAL' || state === 'PUBLISHED';
  return {
    requestEdit: hasReadyOriginal && idle,
    submitOriginalForApproval: state === 'RAW' && hasReadyOriginal && hasDeliverable && acceptsUnedited,
    publishAsIs: state === 'RAW' && hasReadyOriginal && !hasDeliverable,
    review: state === 'YOUR_REVIEW',
    markPublished: state === 'FINAL' || (state === 'APPROVED_BY_YOU' && !hasDeliverable),
  };
}
