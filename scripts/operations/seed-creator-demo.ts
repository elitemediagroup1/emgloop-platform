// Seed creator demo -- everything Matt and Charlie need to test the Creator Hub
// end to end, on STAGING, in one run that can be repeated.
//
// WHAT IT CREATES, inside ONE organization named by slug, as the EMG owner named by
// email (who must be an ACTIVE OWNER or ADMIN there): a PERSON Party for the creator,
// established MANUAL; a TALENT_REPRESENTATION Relationship with the creator as the
// COUNTERPARTY; a CREATOR login (an invitation, accepted through the normal
// /crm/accept-invite page); a CreatorProfile bound to that login; one confirmed
// Opportunity with an ACTIVE Campaign and two Deliverables, plus one pitching
// Opportunity with no campaign; twelve weeks of Instagram audience and performance
// evidence and five compensation entries, every row marked source=SEEDED_DEMO; and
// the "Creator production" work type. Every write goes through the same governed
// path a page would use (PartyService, CrmRelationshipService, IamRepository, the
// creator domain repositories) -- nothing here touches a Prisma model directly.
//
// STAGING ONLY, TWO GUARDS, BOTH REQUIRED. Before the database client is even
// loaded the runner refuses unless (1) the DATABASE_URL host is a *.neon.tech or a
// local host AND (2) LOOP_SEED_TARGET is exactly "staging". Production is also on
// Neon, so the host check alone cannot tell the two apart: it catches a mistyped or
// foreign URL, and the LOOP_SEED_TARGET assertion is the human saying which database
// this is. The workflow that runs this reads ONLY the staging secret, through the
// staging OIDC role, so neither guard is the only thing standing between it and
// production -- but neither is decorative either.
//
// IDEMPOTENT BY NATURAL KEY. The creator login by email; the Party through the
// profile that names it; the profile by login (or, for an unbound profile from a
// partial run, by handle); the relationship by kind on the Party; opportunities by
// title; the campaign by name; deliverables by title within the campaign;
// compensation by description; audience and performance rows by (platform,
// window end), anchored to UTC Monday boundaries. A rerun creates nothing that
// already exists and changes nothing a person has touched. It never resurrects: a
// DISABLED or removed member at the creator email is refused, not re-invited.
//
// THE ONE THING IT REFRESHES is the invitation. A pending invitation's token is
// hashed and cannot be shown again, so a rerun for a still-INVITED creator revokes
// the pending invitation and issues a fresh one, exactly as "Resend" does on the
// Team page. The accept URL is printed once, at the end, or written to the file
// named by --invite-out so the workflow can put it in the job summary and not the
// job log. It is never logged anywhere else.
//
// --dry-run reads and reports what it would create and writes nothing.
//
// A partial run can leave an established Party with no profile (the two steps that
// create them are adjacent, so the window is one write). The next run makes a
// fresh Party; the orphan is harmless and visible in People, and a person removes it.

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type {
  Prisma,
  CreateCreatorProfileInput,
  CreateOpportunityInput,
  CreateCampaignInput,
  CampaignTransitionInput,
  DeclareDeliverableInput,
} from '@emgloop/database';
import { DEFAULT_DELIVERABLE_REQUIREMENTS, INVITATION_ACCEPT_PATH, type DeliverableRequirement } from '@emgloop/shared';

export const SEED_TAG = 'creator-hub-demo';
export const DEFAULT_CREATOR_NAME = 'Denise Rivera';
export const DEFAULT_APP_URL = 'https://staging--emgloop2.netlify.app';
export const INVITATION_DAYS = 14;
export const EVIDENCE_SOURCE = 'SEEDED_DEMO';
export const EVIDENCE_PLATFORM = 'INSTAGRAM';
export const EVIDENCE_WEEKS = 12;
export const AUDIENCE_START = 91_000;
export const AUDIENCE_END = 103_400;
export const LATEST_GROWTH_30D_PCT = 4.2;
export const CREATOR_ROLE = 'CREATOR';
export const RELATIONSHIP_KIND = 'TALENT_REPRESENTATION';
export const KONA_OPPORTUNITY_TITLE = 'Kona — product video';
export const KONA_CAMPAIGN_NAME = 'Kona Product Video';
export const SCULPEY_OPPORTUNITY_TITLE = 'Sculpey — holiday series';
export const REEL_1_TITLE = 'Reel 1 of 2';
export const REEL_2_TITLE = 'Reel 2 of 2';

const DAY_MS = 86_400_000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Hosts a seed may point at: Neon (where staging lives) or a local database. Production is also Neon; see the header. */
export const ALLOWED_DB_HOST = /(^|\.)neon\.tech$|^localhost$|^127\.0\.0\.1$|^\[::1\]$/i;

// --- Arguments and environment --------------------------------------------------------

export interface SeedArgs {
  organization: string;
  ownerEmail: string;
  creatorEmail: string;
  creatorName: string;
  editorEmail: string;
  appUrl: string;
  inviteOut: string;
  dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): SeedArgs {
  const args: SeedArgs = {
    organization: '',
    ownerEmail: '',
    creatorEmail: '',
    creatorName: DEFAULT_CREATOR_NAME,
    editorEmail: '',
    appUrl: DEFAULT_APP_URL,
    inviteOut: '',
    dryRun: false,
  };
  const valued: Record<string, keyof SeedArgs> = {
    '--organization': 'organization',
    '--org': 'organization',
    '--owner-email': 'ownerEmail',
    '--creator-email': 'creatorEmail',
    '--creator-name': 'creatorName',
    '--editor-email': 'editorEmail',
    '--app-url': 'appUrl',
    '--invite-out': 'inviteOut',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const key = valued[flag];
    if (!key) continue;
    const value = (argv[i + 1] ?? '').trim();
    i += 1;
    if (key === 'dryRun') continue;
    // An explicitly empty value keeps the default (the workflow passes optional inputs through unchanged).
    if (value !== '' || key === 'editorEmail' || key === 'inviteOut') args[key] = value;
  }
  return args;
}

export interface SeedRequest {
  organizationSlug: string;
  ownerEmail: string;
  creatorEmail: string;
  creatorName: string;
  editorEmail: string | null;
  appUrl: string;
  inviteOut: string | null;
  dryRun: boolean;
}

export function validateArgs(args: SeedArgs): { ok: true; request: SeedRequest } | { ok: false; reason: string } {
  const organizationSlug = args.organization.trim();
  const ownerEmail = args.ownerEmail.trim().toLowerCase();
  const creatorEmail = args.creatorEmail.trim().toLowerCase();
  const editorEmail = args.editorEmail.trim().toLowerCase();
  const creatorName = args.creatorName.trim();
  const appUrl = args.appUrl.trim().replace(/\/+$/, '');
  if (!SLUG.test(organizationSlug)) return { ok: false, reason: '--organization <slug> is required: lowercase letters, digits and hyphens' };
  if (!EMAIL.test(ownerEmail)) return { ok: false, reason: '--owner-email <email> is required' };
  if (!EMAIL.test(creatorEmail)) return { ok: false, reason: '--creator-email <email> is required' };
  if (editorEmail !== '' && !EMAIL.test(editorEmail)) return { ok: false, reason: '--editor-email must be an email address' };
  if (creatorEmail === ownerEmail) return { ok: false, reason: 'the creator email must not be the owner email' };
  if (editorEmail !== '' && editorEmail === creatorEmail) return { ok: false, reason: 'the editor email must not be the creator email' };
  if (creatorName === '' || creatorName.length > 120) return { ok: false, reason: '--creator-name must be 1-120 characters' };
  let parsed: URL;
  try {
    parsed = new URL(appUrl);
  } catch {
    return { ok: false, reason: '--app-url must be an absolute http(s) URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, reason: '--app-url must be an absolute http(s) URL' };
  return {
    ok: true,
    request: {
      organizationSlug,
      ownerEmail,
      creatorEmail,
      creatorName,
      editorEmail: editorEmail === '' ? null : editorEmail,
      appUrl,
      inviteOut: args.inviteOut.trim() === '' ? null : args.inviteOut.trim(),
      dryRun: args.dryRun,
    },
  };
}

export type TargetCheck = { ok: true } | { ok: false; reason: string };

/**
 * Both guards, in order; the first failure is the reason. Neither prints the URL or
 * its host: a refusal names only which check failed.
 */
export function checkTarget(env: NodeJS.ProcessEnv): TargetCheck {
  const raw = env.DATABASE_URL?.trim();
  if (!raw) return { ok: false, reason: 'DATABASE_URL_MISSING' };
  let host: string;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') return { ok: false, reason: 'DATABASE_URL_NOT_POSTGRES' };
    host = url.hostname;
  } catch {
    return { ok: false, reason: 'DATABASE_URL_UNPARSEABLE' };
  }
  if (!ALLOWED_DB_HOST.test(host)) return { ok: false, reason: 'DATABASE_HOST_NOT_ALLOWED' };
  if ((env.LOOP_SEED_TARGET ?? '') !== 'staging') return { ok: false, reason: 'LOOP_SEED_TARGET_NOT_STAGING' };
  return { ok: true };
}

/** 32 random bytes as hex, hashed with sha256 for storage -- the same shape apps/web/src/auth/auth.ts mints. */
export function mintInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: createHash('sha256').update(token).digest('hex') };
}

export function acceptUrlFor(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}${INVITATION_ACCEPT_PATH}?token=${encodeURIComponent(token)}`;
}

// --- The plan: pure, deterministic, a function of the clock only -------------------

export function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The most recent Monday 00:00 UTC on or before `now`: the boundary weekly rows are keyed on. */
export function weekAnchor(now: Date): Date {
  const day = utcMidnight(now);
  const back = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - back * DAY_MS);
}

const days = (from: Date, n: number): Date => new Date(from.getTime() + n * DAY_MS);

/** The creator's handles, derived from the display name: "Denise Rivera" reads @denise.rivera / @deniserivera. */
export function handlesFor(creatorName: string): { instagram: string; tiktok: string; youtube: string } {
  const words = creatorName
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w !== '');
  const base = words.length > 0 ? words : ['creator'];
  return { instagram: `@${base.join('.')}`, tiktok: `@${base.join('')}`, youtube: creatorName.trim() };
}

export interface AudienceRow {
  platform: string;
  observedAt: Date;
  followers: number;
  growth30dPct: number | null;
  source: string;
}

export interface PerformanceRow {
  platform: string;
  contentId: null;
  windowStart: Date;
  windowEnd: Date;
  observedAt: Date;
  metrics: { views: number; reach: number; likes: number; comments: number; saves: number; shares: number; completionPct: number };
  source: string;
}

export interface CompensationRow {
  description: string;
  amountMinor: number;
  currency: 'USD';
  state: string;
  occurredAt: Date;
  source: string;
  /** Resolved to ids at apply time, when the campaign and deliverable exist. */
  campaignName: string | null;
  deliverableTitle: string | null;
}

export interface EvidencePlan {
  audience: AudienceRow[];
  performance: PerformanceRow[];
  compensation: CompensationRow[];
}

// Hand-written shapes, so the chart reads like a real quarter and never like a die roll.
const VIEW_SHAPE = [0.14, 0.31, 0.22, 0.47, 0.39, 0.66, 0.52, 0.83, 0.61, 0.74, 0.92, 1.0] as const;
const COMPLETION_SHAPE = [54, 57, 55, 61, 58, 64, 60, 69, 63, 66, 71, 68] as const;
const FOLLOWER_WOBBLE = [0, 60, 110] as const;

export function evidencePlan(now: Date): EvidencePlan {
  const anchor = weekAnchor(now);
  const today = utcMidnight(now);
  const audience: AudienceRow[] = [];
  const performance: PerformanceRow[] = [];
  for (let i = 0; i < EVIDENCE_WEEKS; i += 1) {
    const windowEnd = days(anchor, -(EVIDENCE_WEEKS - 1 - i) * 7);
    const windowStart = days(windowEnd, -7);
    const last = i === EVIDENCE_WEEKS - 1;
    const linear = AUDIENCE_START + ((AUDIENCE_END - AUDIENCE_START) * i) / (EVIDENCE_WEEKS - 1);
    // The weekly step (~1,127) dwarfs the wobble (<=110), so the series stays strictly increasing.
    const wobble = i === 0 || last ? 0 : FOLLOWER_WOBBLE[i % 3]!;
    audience.push({
      platform: EVIDENCE_PLATFORM,
      observedAt: windowEnd,
      followers: Math.round(linear) + wobble,
      growth30dPct: last ? LATEST_GROWTH_30D_PCT : null,
      source: EVIDENCE_SOURCE,
    });
    const views = 8_000 + Math.round(7_000 * VIEW_SHAPE[i]!);
    performance.push({
      platform: EVIDENCE_PLATFORM,
      contentId: null,
      windowStart,
      windowEnd,
      observedAt: windowEnd,
      source: EVIDENCE_SOURCE,
      metrics: {
        views,
        reach: Math.round(views * 0.82),
        likes: Math.round(views * 0.061),
        comments: Math.round(views * 0.0042),
        saves: Math.round(views * 0.018),
        shares: Math.round(views * 0.0095),
        completionPct: COMPLETION_SHAPE[i]!,
      },
    });
  }
  const compensation: CompensationRow[] = [
    { description: `${KONA_CAMPAIGN_NAME} — ${REEL_1_TITLE}`, amountMinor: 175_000, currency: 'USD', state: 'EXPECTED', occurredAt: days(today, 4), source: EVIDENCE_SOURCE, campaignName: KONA_CAMPAIGN_NAME, deliverableTitle: REEL_1_TITLE },
    { description: `${KONA_CAMPAIGN_NAME} — ${REEL_2_TITLE}`, amountMinor: 175_000, currency: 'USD', state: 'EXPECTED', occurredAt: days(today, 18), source: EVIDENCE_SOURCE, campaignName: KONA_CAMPAIGN_NAME, deliverableTitle: REEL_2_TITLE },
    { description: 'Sun & Soil — spring series (completed)', amountMinor: 240_000, currency: 'USD', state: 'PAID', occurredAt: days(today, -40), source: EVIDENCE_SOURCE, campaignName: null, deliverableTitle: null },
    { description: 'Sun & Soil — bonus reach', amountMinor: 50_000, currency: 'USD', state: 'AVAILABLE', occurredAt: days(today, -12), source: EVIDENCE_SOURCE, campaignName: null, deliverableTitle: null },
    { description: 'Meadow Skincare — March reel', amountMinor: 120_000, currency: 'USD', state: 'RECEIVED_BY_EMG', occurredAt: days(today, -6), source: EVIDENCE_SOURCE, campaignName: null, deliverableTitle: null },
  ];
  return { audience, performance, compensation };
}

export interface CommercialPlan {
  kona: Omit<CreateOpportunityInput, 'organizationId' | 'creatorPartyId' | 'createdByUserId' | 'relationshipId'>;
  sculpey: Omit<CreateOpportunityInput, 'organizationId' | 'creatorPartyId' | 'createdByUserId' | 'relationshipId'>;
  campaign: Omit<CreateCampaignInput, 'organizationId' | 'creatorPartyId' | 'createdByUserId' | 'opportunityId'>;
  campaignState: string;
  deliverables: Array<Omit<DeclareDeliverableInput, 'organizationId' | 'campaignId' | 'creatorPartyId' | 'createdByUserId'>>;
}

export const REEL_1_REQUIREMENTS: readonly DeliverableRequirement[] = Object.freeze([
  { key: 'creator', label: 'Your approval', required: true },
  { key: 'emg', label: 'EMG approval', required: true },
  { key: 'brand', label: "Kona's approval", required: true },
  { key: 'published', label: 'Published', required: true },
]);

export function commercialPlan(now: Date): CommercialPlan {
  const today = utcMidnight(now);
  return {
    kona: {
      title: KONA_OPPORTUNITY_TITLE,
      stage: 'Confirmed',
      category: 'OPEN',
      creatorVisibleState: 'CONFIRMED',
      brandLabel: 'Kona',
      brandVisibleToCreator: true,
      summaryForCreator: 'Kona wants a product unboxing reel and a follow-up; two reels, published by the end of the month.',
      internalNotes: 'Agency: Harbor. Net-30.',
      amountMinor: 350_000,
      currency: 'USD',
      expectedCloseDate: days(today, 30),
    },
    sculpey: {
      title: SCULPEY_OPPORTUNITY_TITLE,
      stage: 'Pitching',
      category: 'OPEN',
      creatorVisibleState: 'PITCHING',
      brandLabel: 'Sculpey',
      brandVisibleToCreator: false,
      summaryForCreator: 'A brand is interested in a holiday craft series; EMG is pitching.',
      internalNotes: null,
      amountMinor: null,
      currency: null,
      expectedCloseDate: null,
    },
    campaign: {
      name: KONA_CAMPAIGN_NAME,
      brandLabel: 'Kona',
      brandVisibleToCreator: true,
      creatorBrief: 'Two reels featuring Kona. Kona should appear in the first five seconds.',
      termsSummary: '$3,500 for two reels; usage 6 months',
      startDate: today,
      endDate: days(today, 30),
    },
    campaignState: 'ACTIVE',
    deliverables: [
      { title: REEL_1_TITLE, deliverableType: 'REEL', dueAt: days(today, 4), requirements: [...REEL_1_REQUIREMENTS] as unknown as Prisma.InputJsonValue, acceptsUnedited: false },
      { title: REEL_2_TITLE, deliverableType: 'REEL', dueAt: days(today, 18), requirements: [...DEFAULT_DELIVERABLE_REQUIREMENTS] as unknown as Prisma.InputJsonValue, acceptsUnedited: true },
    ],
  };
}

export function profilePlan(creatorName: string): Omit<CreateCreatorProfileInput, 'organizationId' | 'partyId' | 'userId' | 'defaultEditorUserId' | 'createdByUserId'> {
  const h = handlesFor(creatorName);
  return {
    displayName: creatorName,
    handle: h.instagram,
    bio: 'Lifestyle, pets and home. Reels first; longer pieces when the story needs them.',
    categories: ['Lifestyle', 'Pets', 'Home'],
    socialAccounts: [
      { platform: 'INSTAGRAM', handle: h.instagram, state: 'SEEDED_DEMO' },
      { platform: 'TIKTOK', handle: h.tiktok, state: 'NOT_CONNECTED' },
      { platform: 'YOUTUBE', handle: h.youtube, state: 'NOT_CONNECTED' },
    ],
    payoutState: 'NOT_SET_UP',
    rateInfo: { visibleToCreator: true, reelFromUsd: 1500 },
    documents: [],
    preferences: { notifications: { email: true } },
  };
}

// --- Dependencies: the governed paths, and only those ----------------------------------

interface SeedUser {
  id: string;
  email: string;
  name: string | null;
  status: string;
}

type Authority = { granted: true; systemRole: string } | { granted: false; reason: string };
type PartyOutcome = { outcome: string; party?: { id: string }; reason?: string };
type RelationshipOutcome = { outcome: string; value?: { relationship: { id: string } }; violations?: readonly string[]; refusals?: readonly unknown[] };

export interface SeedDeps {
  organizations: { findBySlug(slug: string): Promise<{ id: string; slug: string } | null> };
  auth: {
    findUserByEmail(organizationId: string, email: string): Promise<SeedUser | null>;
    revokeAllForUser(userId: string): Promise<void>;
  };
  memberships: { authority(organizationId: string, userId: string): Promise<Authority> };
  iam: {
    prepareInvitation(params: { organizationId: string; email: string; name?: string; systemRole: string; invitedByUserId?: string | null }): Promise<{ ok: true; userId: string; reused: boolean } | { ok: false; reason: string }>;
    createInvitation(data: { organizationId: string; email: string; inviterId: string; systemRole?: string; tokenHash: string; expiresAt?: Date }): Promise<{ id: string }>;
    listInvitations(organizationId: string): Promise<{ id: string; email: string; status: string }[]>;
    revokeInvitation(organizationId: string, id: string): Promise<void>;
  };
  audit: {
    record(args: { organizationId: string; action: string; userId?: string | null; actorName?: string; entityType?: string | null; entityId?: string | null; metadata?: Record<string, unknown> }): Promise<unknown>;
  };
  parties: {
    create(organizationId: string, actorUserId: string, input: { partyType: string; displayName?: string | null }, options?: { actorName?: string | null }): Promise<PartyOutcome>;
    establish(organizationId: string, actorUserId: string, partyId: string, basis: string, options?: { actorName?: string | null }): Promise<PartyOutcome>;
  };
  relationships: { forParty(organizationId: string, partyId: string): Promise<{ id: string; kind: string; state: string }[]> };
  relationshipService: {
    create(
      actor: { organizationId: string; userId: string; actorName?: string | null },
      input: { kind: string; sides: readonly { side: 'COUNTERPARTY' | 'A' | 'B'; partyId: string; role: 'CREATOR' }[]; occurredAt: Date; label?: string | null; ownerUserId?: string | null },
    ): Promise<RelationshipOutcome>;
  };
  creator: {
    profileForUser(organizationId: string, userId: string): Promise<{ id: string; partyId: string; userId: string | null; handle: string | null } | null>;
    listProfiles(organizationId: string): Promise<{ id: string; partyId: string; userId: string | null; handle: string | null }[]>;
    createProfile(input: CreateCreatorProfileInput): Promise<{ id: string; partyId: string; userId: string | null; handle: string | null }>;
    bindUser(organizationId: string, id: string, userId: string | null): Promise<unknown>;
    listAudience(organizationId: string, creatorProfileId: string): Promise<{ platform: string; observedAt: Date }[]>;
    listPerformance(organizationId: string, creatorProfileId: string, filter?: { platform?: string }): Promise<{ platform: string; windowEnd: Date; contentId: string | null }[]>;
    listCompensation(organizationId: string, creatorProfileId: string): Promise<{ description: string }[]>;
    addAudience(data: Prisma.CreatorAudienceSnapshotUncheckedCreateInput): Promise<unknown>;
    addPerformance(data: Prisma.CreatorPerformanceSnapshotUncheckedCreateInput): Promise<unknown>;
    addCompensation(data: Prisma.CreatorCompensationEntryUncheckedCreateInput): Promise<unknown>;
  };
  commercial: {
    listOpportunitiesForCreator(organizationId: string, creatorPartyId: string): Promise<{ id: string; title: string }[]>;
    createOpportunity(input: CreateOpportunityInput): Promise<{ id: string }>;
    listCampaignsForCreator(organizationId: string, creatorPartyId: string): Promise<{ id: string; name: string; state: string }[]>;
    createCampaign(input: CreateCampaignInput): Promise<{ id: string; state: string }>;
    transitionCampaign(input: CampaignTransitionInput): Promise<unknown>;
    listDeliverablesForCreator(organizationId: string, creatorPartyId: string): Promise<{ id: string; title: string; campaignId: string }[]>;
    declareDeliverable(input: DeclareDeliverableInput): Promise<{ id: string }>;
  };
  productions: { ensureProductionWorkType(organizationId: string, createdByUserId: string): Promise<string> };
  now: () => Date;
  mintToken: () => { token: string; tokenHash: string };
  writeFile: (path: string, content: string) => Promise<void>;
  log: (line: string) => void;
}

// --- The run ---------------------------------------------------------------------------

export type StepAction = 'CREATED' | 'REUSED' | 'WOULD_CREATE' | 'SKIPPED';
export type LoginMode = 'EXISTING_ACTIVE' | 'INVITED' | 'REINVITED' | 'WOULD_INVITE';

export interface SeedResult {
  overall: 'SEEDED' | 'DRY_RUN' | 'FAILED_PRECONDITION' | 'STOPPED';
  error: string | null;
  organization: { id: string; slug: string } | null;
  creatorProfileId: string | null;
  login: LoginMode | null;
  /** The one-time accept URL, when this run issued one. Never in the log when --invite-out is set. */
  acceptUrl: string | null;
  steps: Record<string, StepAction>;
  evidence: Record<'audience' | 'performance' | 'compensation', { created: number; reused: number; wouldCreate: number }>;
}

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

class Stop extends Error {
  constructor(readonly outcome: 'FAILED_PRECONDITION' | 'STOPPED', message: string) {
    super(message);
  }
}

export async function runSeed(request: SeedRequest, deps: SeedDeps): Promise<SeedResult> {
  const result: SeedResult = {
    overall: request.dryRun ? 'DRY_RUN' : 'SEEDED',
    error: null,
    organization: null,
    creatorProfileId: null,
    login: null,
    acceptUrl: null,
    steps: {},
    evidence: {
      audience: { created: 0, reused: 0, wouldCreate: 0 },
      performance: { created: 0, reused: 0, wouldCreate: 0 },
      compensation: { created: 0, reused: 0, wouldCreate: 0 },
    },
  };
  const dry = request.dryRun;
  const step = (name: string, action: StepAction, extra: Record<string, string | number | boolean | null> = {}) => {
    result.steps[name] = action;
    deps.log(line({ event: 'STEP', step: name, action, ...extra }));
  };
  const refuse = (reason: string): never => {
    throw new Stop('FAILED_PRECONDITION', reason);
  };

  try {
    // ---- Resolve: organization, owner, editor, creator login (reads only) ----------------
    if (!SLUG.test(request.organizationSlug)) refuse('organization must be lowercase letters, digits and hyphens');
    const org = await deps.organizations.findBySlug(request.organizationSlug);
    if (!org) return refuse('unknown organization');
    result.organization = { id: org.id, slug: org.slug };

    const owner = await deps.auth.findUserByEmail(org.id, request.ownerEmail);
    if (!owner) return refuse('owner email is not a member of the organization');
    const ownerAuthority = await deps.memberships.authority(org.id, owner.id);
    if (!ownerAuthority.granted) return refuse('owner email is not an ACTIVE member of the organization');
    if (ownerAuthority.systemRole !== 'OWNER' && ownerAuthority.systemRole !== 'ADMIN') {
      return refuse(`owner email holds ${ownerAuthority.systemRole}; an OWNER or ADMIN must record the seed`);
    }
    const actorName = owner.name?.trim() || undefined;

    let editorUserId: string | null = null;
    if (request.editorEmail) {
      const editor = await deps.auth.findUserByEmail(org.id, request.editorEmail);
      const editorAuthority = editor ? await deps.memberships.authority(org.id, editor.id) : null;
      if (!editor || !editorAuthority?.granted) return refuse('editor email is not an ACTIVE member of the organization');
      editorUserId = editor.id;
    }

    const existingCreator = await deps.auth.findUserByEmail(org.id, request.creatorEmail);
    if (existingCreator?.status === 'DISABLED') {
      return refuse('creator email belongs to a DISABLED or removed member; this seed never resurrects one -- use another email');
    }
    if (existingCreator?.status === 'ACTIVE') {
      const creatorAuthority = await deps.memberships.authority(org.id, existingCreator.id);
      if (!creatorAuthority.granted) return refuse('creator email is ACTIVE but holds no active membership');
      if (creatorAuthority.systemRole !== CREATOR_ROLE) {
        return refuse(`creator email belongs to an ACTIVE ${creatorAuthority.systemRole} member; the creator seat needs a CREATOR login -- use another email`);
      }
    }
    deps.log(line({
      event: 'RESOLVED',
      organization: org.slug,
      OWNER_ROLE: ownerAuthority.systemRole,
      EDITOR: editorUserId !== null,
      CREATOR_LOGIN: existingCreator ? existingCreator.status : 'ABSENT',
      DRY_RUN: dry,
    }));

    // ---- Existing profile: by login, else an unbound profile from a partial run ----------
    const handles = handlesFor(request.creatorName);
    let profile = existingCreator ? await deps.creator.profileForUser(org.id, existingCreator.id) : null;
    if (!profile) {
      profile = (await deps.creator.listProfiles(org.id)).find((p) => p.userId === null && p.handle === handles.instagram) ?? null;
    }

    // ---- 1. Party ---------------------------------------------------------------------
    let partyId: string | null = profile?.partyId ?? null;
    if (partyId) {
      step('PARTY', 'REUSED');
    } else if (dry) {
      step('PARTY', 'WOULD_CREATE');
    } else {
      const created = await deps.parties.create(org.id, owner.id, { partyType: 'PERSON', displayName: request.creatorName }, { actorName });
      if (created.outcome !== 'RECORDED' || !created.party) throw new Stop('STOPPED', `party.create: ${created.outcome}${created.reason ? ` (${created.reason})` : ''}`);
      partyId = created.party.id;
      step('PARTY', 'CREATED');
    }
    if (partyId) {
      // Idempotent: an already-established Party comes back ALREADY_ESTABLISHED, and no audit row is written for it.
      const established = dry ? { outcome: 'DRY_RUN' } : await deps.parties.establish(org.id, owner.id, partyId, 'MANUAL', { actorName });
      if (established.outcome === 'RECORDED') step('PARTY_ESTABLISHED', 'CREATED');
      else if (established.outcome === 'ALREADY_ESTABLISHED') step('PARTY_ESTABLISHED', 'REUSED');
      else if (dry) step('PARTY_ESTABLISHED', 'WOULD_CREATE');
      else throw new Stop('STOPPED', `party.establish: ${established.outcome}`);
    } else {
      step('PARTY_ESTABLISHED', 'WOULD_CREATE');
    }

    // ---- 2. Relationship ---------------------------------------------------------------
    let relationshipId: string | null = null;
    if (partyId) {
      const active = (await deps.relationships.forParty(org.id, partyId)).find((r) => r.kind === RELATIONSHIP_KIND && r.state === 'ACTIVE') ?? null;
      if (active) {
        relationshipId = active.id;
        step('RELATIONSHIP', 'REUSED');
      } else if (dry) {
        step('RELATIONSHIP', 'WOULD_CREATE');
      } else {
        const created = await deps.relationshipService.create(
          { organizationId: org.id, userId: owner.id, actorName },
          {
            kind: RELATIONSHIP_KIND,
            sides: [{ side: 'COUNTERPARTY', partyId, role: 'CREATOR' }],
            occurredAt: deps.now(),
            label: `${request.creatorName} — talent representation`,
            ownerUserId: owner.id,
          },
        );
        if (created.outcome === 'RECORDED' && created.value) {
          relationshipId = created.value.relationship.id;
          step('RELATIONSHIP', 'CREATED');
        } else if (created.outcome === 'DUPLICATE') {
          // The natural key is held by an ENDED relationship: a person ended it, and this seed does not undo that.
          step('RELATIONSHIP', 'SKIPPED', { reason: 'DUPLICATE_NOT_ACTIVE' });
        } else {
          const detail = created.violations?.join(',') ?? (created.refusals ? `${created.refusals.length} party refusal(s)` : '');
          throw new Stop('STOPPED', `relationship.create: ${created.outcome}${detail ? ` (${detail})` : ''}`);
        }
      }
    } else {
      step('RELATIONSHIP', 'WOULD_CREATE');
    }

    // ---- 3. Login ------------------------------------------------------------------------
    let creatorUserId: string | null = existingCreator?.id ?? null;
    if (existingCreator?.status === 'ACTIVE') {
      result.login = 'EXISTING_ACTIVE';
      step('LOGIN', 'REUSED', { mode: result.login });
    } else if (dry) {
      result.login = 'WOULD_INVITE';
      step('LOGIN', 'WOULD_CREATE', { mode: result.login });
    } else {
      // A pending token is hashed and cannot be shown again: supersede it, as Resend does.
      const pending = (await deps.iam.listInvitations(org.id)).filter((i) => i.email === request.creatorEmail && i.status === 'PENDING');
      for (const p of pending) await deps.iam.revokeInvitation(org.id, p.id);
      const prepared = await deps.iam.prepareInvitation({
        organizationId: org.id,
        email: request.creatorEmail,
        name: request.creatorName,
        systemRole: CREATOR_ROLE,
        invitedByUserId: owner.id,
      });
      if (!prepared.ok) throw new Stop('STOPPED', `prepareInvitation: ${prepared.reason}`);
      if (prepared.reused) await deps.auth.revokeAllForUser(prepared.userId);
      const { token, tokenHash } = deps.mintToken();
      await deps.iam.createInvitation({
        organizationId: org.id,
        email: request.creatorEmail,
        systemRole: CREATOR_ROLE,
        inviterId: owner.id,
        tokenHash,
        expiresAt: new Date(deps.now().getTime() + INVITATION_DAYS * DAY_MS),
      });
      await deps.audit.record({
        organizationId: org.id,
        userId: owner.id,
        actorName,
        action: 'user.invited',
        entityType: 'user',
        entityId: prepared.userId,
        metadata: { email: request.creatorEmail, role: CREATOR_ROLE, seed: SEED_TAG, superseded: pending.length },
      });
      creatorUserId = prepared.userId;
      result.acceptUrl = acceptUrlFor(request.appUrl, token);
      result.login = existingCreator ? 'REINVITED' : 'INVITED';
      step('LOGIN', 'CREATED', { mode: result.login, SUPERSEDED_INVITATIONS: pending.length });
    }

    // ---- 4. Profile ----------------------------------------------------------------------
    if (profile) {
      if (profile.userId === null && creatorUserId && !dry) {
        await deps.creator.bindUser(org.id, profile.id, creatorUserId);
        step('PROFILE', 'REUSED', { BOUND_LOGIN: true });
      } else {
        step('PROFILE', 'REUSED', { BOUND_LOGIN: profile.userId !== null });
      }
    } else if (dry || !partyId) {
      step('PROFILE', 'WOULD_CREATE');
    } else {
      profile = await deps.creator.createProfile({
        organizationId: org.id,
        partyId,
        userId: creatorUserId,
        defaultEditorUserId: editorUserId,
        createdByUserId: owner.id,
        ...profilePlan(request.creatorName),
      });
      step('PROFILE', 'CREATED');
    }
    result.creatorProfileId = profile?.id ?? null;

    // ---- 5. Commercial -------------------------------------------------------------------
    const plan = commercialPlan(deps.now());
    let campaignId: string | null = null;
    const deliverableIds = new Map<string, string>();
    if (partyId) {
      const opportunities = await deps.commercial.listOpportunitiesForCreator(org.id, partyId);
      const kona = opportunities.find((o) => o.title === plan.kona.title) ?? null;
      let konaId: string | null = kona?.id ?? null;
      if (kona) step('OPPORTUNITY_KONA', 'REUSED');
      else if (dry) step('OPPORTUNITY_KONA', 'WOULD_CREATE');
      else {
        konaId = (await deps.commercial.createOpportunity({ ...plan.kona, organizationId: org.id, creatorPartyId: partyId, createdByUserId: owner.id, relationshipId })).id;
        step('OPPORTUNITY_KONA', 'CREATED');
      }

      const campaigns = await deps.commercial.listCampaignsForCreator(org.id, partyId);
      const campaign = campaigns.find((c) => c.name === plan.campaign.name) ?? null;
      if (campaign) {
        campaignId = campaign.id;
        step('CAMPAIGN_KONA', 'REUSED', { state: campaign.state });
      } else if (dry) {
        step('CAMPAIGN_KONA', 'WOULD_CREATE');
      } else {
        const created = await deps.commercial.createCampaign({ ...plan.campaign, organizationId: org.id, creatorPartyId: partyId, createdByUserId: owner.id, opportunityId: konaId });
        await deps.commercial.transitionCampaign({ organizationId: org.id, campaignId: created.id, toState: plan.campaignState, actorUserId: owner.id, note: 'Seeded demo: the campaign is underway.', creatorVisible: true });
        campaignId = created.id;
        step('CAMPAIGN_KONA', 'CREATED', { state: plan.campaignState });
      }

      const deliverables = campaignId ? (await deps.commercial.listDeliverablesForCreator(org.id, partyId)).filter((d) => d.campaignId === campaignId) : [];
      for (const [index, spec] of plan.deliverables.entries()) {
        const name = `DELIVERABLE_REEL_${index + 1}`;
        const existing = deliverables.find((d) => d.title === spec.title) ?? null;
        if (existing) {
          deliverableIds.set(spec.title, existing.id);
          step(name, 'REUSED');
        } else if (dry || !campaignId) {
          step(name, 'WOULD_CREATE');
        } else {
          const created = await deps.commercial.declareDeliverable({ ...spec, organizationId: org.id, campaignId, creatorPartyId: partyId, createdByUserId: owner.id });
          deliverableIds.set(spec.title, created.id);
          step(name, 'CREATED');
        }
      }

      if (opportunities.some((o) => o.title === plan.sculpey.title)) step('OPPORTUNITY_SCULPEY', 'REUSED');
      else if (dry) step('OPPORTUNITY_SCULPEY', 'WOULD_CREATE');
      else {
        await deps.commercial.createOpportunity({ ...plan.sculpey, organizationId: org.id, creatorPartyId: partyId, createdByUserId: owner.id, relationshipId });
        step('OPPORTUNITY_SCULPEY', 'CREATED');
      }
    } else {
      for (const name of ['OPPORTUNITY_KONA', 'CAMPAIGN_KONA', 'DELIVERABLE_REEL_1', 'DELIVERABLE_REEL_2', 'OPPORTUNITY_SCULPEY']) step(name, 'WOULD_CREATE');
    }

    // ---- 6. Evidence ---------------------------------------------------------------------
    const evidence = evidencePlan(deps.now());
    if (profile) {
      const profileId = profile.id;
      const audienceKeys = new Set((await deps.creator.listAudience(org.id, profileId)).map((a) => `${a.platform}|${a.observedAt.toISOString()}`));
      for (const row of evidence.audience) {
        if (audienceKeys.has(`${row.platform}|${row.observedAt.toISOString()}`)) result.evidence.audience.reused += 1;
        else if (dry) result.evidence.audience.wouldCreate += 1;
        else {
          await deps.creator.addAudience({ organizationId: org.id, creatorProfileId: profileId, ...row });
          result.evidence.audience.created += 1;
        }
      }
      const performanceKeys = new Set(
        (await deps.creator.listPerformance(org.id, profileId, { platform: EVIDENCE_PLATFORM }))
          .filter((p) => p.contentId === null)
          .map((p) => `${p.platform}|${p.windowEnd.toISOString()}`),
      );
      for (const row of evidence.performance) {
        if (performanceKeys.has(`${row.platform}|${row.windowEnd.toISOString()}`)) result.evidence.performance.reused += 1;
        else if (dry) result.evidence.performance.wouldCreate += 1;
        else {
          await deps.creator.addPerformance({ organizationId: org.id, creatorProfileId: profileId, ...row });
          result.evidence.performance.created += 1;
        }
      }
      const descriptions = new Set((await deps.creator.listCompensation(org.id, profileId)).map((c) => c.description));
      for (const row of evidence.compensation) {
        if (descriptions.has(row.description)) result.evidence.compensation.reused += 1;
        else if (dry) result.evidence.compensation.wouldCreate += 1;
        else {
          const { campaignName, deliverableTitle, ...data } = row;
          await deps.creator.addCompensation({
            organizationId: org.id,
            creatorProfileId: profileId,
            campaignId: campaignName === KONA_CAMPAIGN_NAME ? campaignId : null,
            deliverableId: deliverableTitle ? (deliverableIds.get(deliverableTitle) ?? null) : null,
            createdByUserId: owner.id,
            ...data,
          });
          result.evidence.compensation.created += 1;
        }
      }
    } else {
      result.evidence.audience.wouldCreate = evidence.audience.length;
      result.evidence.performance.wouldCreate = evidence.performance.length;
      result.evidence.compensation.wouldCreate = evidence.compensation.length;
    }
    for (const kind of ['audience', 'performance', 'compensation'] as const) {
      const e = result.evidence[kind];
      deps.log(line({ event: 'EVIDENCE', kind: kind.toUpperCase(), CREATED: e.created, REUSED: e.reused, WOULD_CREATE: e.wouldCreate, source: EVIDENCE_SOURCE }));
    }

    // ---- 7. Work type --------------------------------------------------------------------
    if (dry) step('WORK_TYPE', 'WOULD_CREATE', { note: 'ensured, not compared' });
    else {
      await deps.productions.ensureProductionWorkType(org.id, owner.id);
      step('WORK_TYPE', 'CREATED', { note: 'ensured (created or already present)' });
    }
  } catch (err) {
    if (err instanceof Stop) {
      result.overall = err.outcome;
      result.error = err.message;
      deps.log(line({ event: err.outcome === 'STOPPED' ? 'STOPPED' : 'PRECONDITION_FAILED', reason: err.message, WROTE: err.outcome === 'STOPPED' }));
      return result;
    }
    throw err;
  }

  // ---- Summary --------------------------------------------------------------------------
  const created = Object.values(result.steps).filter((a) => a === 'CREATED').length;
  const reused = Object.values(result.steps).filter((a) => a === 'REUSED').length;
  const wouldCreate = Object.values(result.steps).filter((a) => a === 'WOULD_CREATE').length;
  deps.log(line({ event: 'VERDICT', OVERALL: result.overall, CREATED: created, REUSED: reused, WOULD_CREATE: wouldCreate, WROTE: !dry }));

  let inviteLine: string;
  if (!result.acceptUrl) {
    inviteLine =
      result.login === 'EXISTING_ACTIVE'
        ? 'The creator already has an ACTIVE CREATOR login: sign in at ' + request.appUrl + '/crm/login with the existing password.'
        : result.login === 'WOULD_INVITE'
          ? 'Dry run: a CREATOR invitation would be issued and its accept link printed here.'
          : 'No invitation was issued.';
  } else if (request.inviteOut) {
    await deps.writeFile(request.inviteOut, result.acceptUrl + '\n');
    inviteLine = `A one-time CREATOR invitation was issued (valid ${INVITATION_DAYS} days). The accept link was written to ${request.inviteOut}; it is not in this log.`;
  } else {
    inviteLine = `Accept the CREATOR invitation (one-time link, valid ${INVITATION_DAYS} days):\n    ${result.acceptUrl}`;
  }
  const summary = [
    '',
    `==== Creator Hub demo seed: ${result.overall} ====`,
    `Organization:        ${request.organizationSlug}`,
    `Recorded by (EMG):   ${request.ownerEmail}`,
    `Creator:             ${request.creatorName} <${request.creatorEmail}>`,
    `Creator profile id:  ${result.creatorProfileId ?? '(not created in a dry run)'}`,
    `Default editor:      ${request.editorEmail ?? '(none)'}`,
    `Steps:               ${Object.entries(result.steps).map(([k, v]) => `${k}=${v}`).join(' ')}`,
    `Evidence rows:       audience ${result.evidence.audience.created}+${result.evidence.audience.reused} · performance ${result.evidence.performance.created}+${result.evidence.performance.reused} · compensation ${result.evidence.compensation.created}+${result.evidence.compensation.reused} (created+reused, all ${EVIDENCE_SOURCE})`,
    '',
    `Creator enters:      ${inviteLine}`,
    `                     After setting a password, sign in and open ${request.appUrl}/app/creator/content -- the first test path.`,
    `EMG enters:          Matt and Charlie sign in with their existing logins at ${request.appUrl}/crm/login; the Creators item in the admin navigation is the EMG side.`,
    '',
  ].join('\n');
  deps.log(summary);
  return result;
}

// --- Wiring ------------------------------------------------------------------------------

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');
  const validated = validateArgs(parseArgs(process.argv.slice(2)));
  if (!validated.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: validated.reason, WROTE: false }));
    return 2;
  }
  // Both target guards run BEFORE the database package loads: its client reads DATABASE_URL when constructed.
  const target = checkTarget(process.env);
  if (!target.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: target.reason, WROTE: false }));
    return 2;
  }

  const { prisma, repositories, createCreatorDomain, PartyService, CrmRelationshipService, CrmRelationshipRepository } = await import('@emgloop/database');
  const domain = createCreatorDomain(prisma, repositories.work);
  try {
    const result = await runSeed(validated.request, {
      organizations: repositories.organizations,
      auth: repositories.auth,
      memberships: repositories.memberships,
      iam: repositories.iam,
      audit: repositories.audit,
      parties: new PartyService(prisma),
      relationships: new CrmRelationshipRepository(prisma),
      relationshipService: new CrmRelationshipService(prisma),
      creator: domain.creator,
      commercial: domain.commercial,
      productions: domain.productions,
      now: () => new Date(),
      mintToken: mintInviteToken,
      writeFile: (path, content) => fs.writeFile(path, content, { mode: 0o600 }),
      log,
    });
    return result.overall === 'SEEDED' || result.overall === 'DRY_RUN' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

const ENTRY_POINT = /[\\/]seed-creator-demo\.ts$/;
if (process.argv[1] && ENTRY_POINT.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : 'unknown';
      process.stdout.write(line({ event: 'RUN_FAILED', reason: detail }) + '\n');
      process.exitCode = 1;
    },
  );
}
