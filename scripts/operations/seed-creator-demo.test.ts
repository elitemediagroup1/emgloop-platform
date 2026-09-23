// Seed creator demo -- what must hold before it touches staging:
//   - arguments parse with the documented defaults and refuse what is missing or malformed;
//   - both target guards refuse on their own: a non-Neon/non-local host, and a missing or
//     non-staging LOOP_SEED_TARGET;
//   - the evidence is a pure function of the clock: twelve weeks, strictly growing followers
//     from 91,000 to 103,400, views inside 8,000-16,000, identical on every call;
//   - a fresh run creates everything through the governed paths and prints the accept link
//     once; a rerun reuses everything, adds no row, and only supersedes a pending invitation;
//   - every refusal happens before any write, and a dry run writes nothing;
//   - the workflow is human-dispatched, staging-only, and interpolates no input.
// No database: the dependencies are an in-memory double of the repository surface the runner uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  ALLOWED_DB_HOST,
  AUDIENCE_END,
  AUDIENCE_START,
  DEFAULT_APP_URL,
  DEFAULT_CREATOR_NAME,
  EVIDENCE_WEEKS,
  KONA_CAMPAIGN_NAME,
  REEL_1_TITLE,
  REEL_2_TITLE,
  acceptUrlFor,
  checkTarget,
  commercialPlan,
  evidencePlan,
  handlesFor,
  mintInviteToken,
  parseArgs,
  runSeed,
  validateArgs,
  weekAnchor,
  type SeedDeps,
  type SeedRequest,
} from './seed-creator-demo';

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const RUNNER_CODE = strip(readFileSync(new URL('./seed-creator-demo.ts', import.meta.url), 'utf8'));
const WORKFLOW = readFileSync(new URL('../../.github/workflows/creator-demo-seed-staging.yml', import.meta.url), 'utf8');

const NOW = new Date('2026-09-23T15:30:00.000Z'); // a Wednesday
const ORG = { id: 'org_staging', slug: 'emg-staging' };
// Loosely typed rows: the double stores whatever the runner hands it, and hands it back.
type Row = any;

// --- An in-memory double of the repository surface --------------------------------------

function world(opts: { users?: Array<{ email: string; status: string; role: string; name?: string }> } = {}) {
  let seq = 0;
  const id = (p: string) => `${p}_${(seq += 1)}`;
  const t = {
    users: [] as Row[],
    invitations: [] as Row[],
    parties: [] as Row[],
    relationships: [] as Row[],
    profiles: [] as Row[],
    opportunities: [] as Row[],
    campaigns: [] as Row[],
    campaignTransitions: [] as Row[],
    deliverables: [] as Row[],
    audience: [] as Row[],
    performance: [] as Row[],
    compensation: [] as Row[],
    workTypes: [] as Row[],
    audits: [] as Row[],
    revokedSessionsFor: [] as string[],
  };
  for (const u of opts.users ?? [{ email: 'matt@emg.test', status: 'ACTIVE', role: 'OWNER', name: 'Matt' }, { email: 'charlie@emg.test', status: 'ACTIVE', role: 'EMPLOYEE', name: 'Charlie' }]) {
    t.users.push({ id: id('user'), organizationId: ORG.id, email: u.email, name: u.name ?? null, status: u.status, role: u.role });
  }
  const lines: string[] = [];
  const files: Record<string, string> = {};
  const inOrg = (rows: Row[], organizationId: string) => rows.filter((r) => r.organizationId === organizationId);
  const userIn = (organizationId: string, userId: string) => t.users.find((u) => u.organizationId === organizationId && u.id === userId) ?? null;
  const authorityOf = (organizationId: string, userId: string) => {
    const u = userIn(organizationId, userId);
    return u && u.status === 'ACTIVE' ? { granted: true as const, systemRole: u.role as string } : { granted: false as const, reason: u ? u.status : 'NO_MEMBERSHIP' };
  };

  const deps: SeedDeps = {
    organizations: { findBySlug: async (slug) => (slug === ORG.slug ? ORG : null) },
    auth: {
      findUserByEmail: async (organizationId, email) => t.users.find((u) => u.organizationId === organizationId && u.email === email.toLowerCase()) ?? null,
      revokeAllForUser: async (userId) => {
        t.revokedSessionsFor.push(userId);
      },
    },
    memberships: { authority: async (organizationId, userId) => authorityOf(organizationId, userId) },
    iam: {
      prepareInvitation: async ({ organizationId, email, name, systemRole, invitedByUserId }) => {
        const existing = t.users.find((u) => u.organizationId === organizationId && u.email === email);
        if (existing && existing.status === 'ACTIVE') return { ok: false, reason: 'active_member' };
        if (t.invitations.some((i) => i.organizationId === organizationId && i.email === email && i.status === 'PENDING' && i.expiresAt > NOW)) return { ok: false, reason: 'pending_exists' };
        for (const i of t.invitations) if (i.organizationId === organizationId && i.email === email && i.status === 'PENDING') i.status = 'REVOKED';
        if (!existing) {
          const user = { id: id('user'), organizationId, email, name: name ?? null, status: 'INVITED', role: systemRole, invitedByUserId };
          t.users.push(user);
          return { ok: true, userId: user.id, reused: false };
        }
        Object.assign(existing, { status: 'INVITED', role: systemRole, name: name ?? existing.name });
        return { ok: true, userId: existing.id, reused: true };
      },
      createInvitation: async (data) => {
        const row = { id: id('inv'), organizationId: data.organizationId, email: data.email, invitedById: data.inviterId, status: 'PENDING', tokenHash: data.tokenHash, expiresAt: data.expiresAt, role: data.systemRole ?? 'EMPLOYEE' };
        t.invitations.push(row);
        return row;
      },
      listInvitations: async (organizationId) => inOrg(t.invitations, organizationId).filter((i) => i.status === 'PENDING').map((i) => ({ id: i.id, email: i.email, status: i.status })),
      revokeInvitation: async (organizationId, invitationId) => {
        const i = t.invitations.find((x) => x.organizationId === organizationId && x.id === invitationId);
        if (i) i.status = 'REVOKED';
      },
    },
    audit: {
      record: async (args) => {
        t.audits.push({ ...args });
      },
    },
    parties: {
      create: async (organizationId, actorUserId, input) => {
        const a = authorityOf(organizationId, actorUserId);
        if (!a.granted || !['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'].includes(a.systemRole)) return { outcome: 'NOT_AUTHORIZED' };
        const party = { id: id('party'), organizationId, partyType: input.partyType, displayName: input.displayName ?? null, established: false };
        t.parties.push(party);
        t.audits.push({ organizationId, action: 'party.created', entityId: party.id });
        return { outcome: 'RECORDED', party };
      },
      establish: async (organizationId, actorUserId, partyId, basis) => {
        const a = authorityOf(organizationId, actorUserId);
        if (!a.granted || !['OWNER', 'ADMIN'].includes(a.systemRole)) return { outcome: 'NOT_AUTHORIZED' };
        const party = t.parties.find((p) => p.organizationId === organizationId && p.id === partyId);
        if (!party) return { outcome: 'NOT_FOUND' };
        if (party.established) return { outcome: 'ALREADY_ESTABLISHED', party };
        party.established = true;
        party.basis = basis;
        t.audits.push({ organizationId, action: 'party.established', entityId: party.id });
        return { outcome: 'RECORDED', party };
      },
    },
    relationships: {
      forParty: async (organizationId, partyId) => inOrg(t.relationships, organizationId).filter((r) => r.partyId === partyId && r.state === 'ACTIVE'),
    },
    relationshipService: {
      create: async (actor, input) => {
        const a = authorityOf(actor.organizationId, actor.userId);
        if (!a.granted || !['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'].includes(a.systemRole)) return { outcome: 'NOT_AUTHORIZED' };
        const side = input.sides[0]!;
        const party = t.parties.find((p) => p.organizationId === actor.organizationId && p.id === side.partyId);
        if (!party || !party.established) return { outcome: 'PARTY_REFUSED', refusals: [{ partyId: side.partyId, refusal: 'NOT_ESTABLISHED' }] };
        if (t.relationships.some((r) => r.organizationId === actor.organizationId && r.kind === input.kind && r.partyId === side.partyId && r.state !== 'VOIDED')) return { outcome: 'DUPLICATE' };
        const relationship = { id: id('rel'), organizationId: actor.organizationId, kind: input.kind, state: 'ACTIVE', partyId: side.partyId, role: side.role, label: input.label ?? null, ownerUserId: input.ownerUserId ?? null, createdByUserId: actor.userId, occurredAt: input.occurredAt };
        t.relationships.push(relationship);
        t.audits.push({ organizationId: actor.organizationId, action: 'relationship.created', entityId: relationship.id });
        return { outcome: 'RECORDED', value: { relationship } };
      },
    },
    creator: {
      profileForUser: async (organizationId, userId) => inOrg(t.profiles, organizationId).find((p) => p.userId === userId) ?? null,
      listProfiles: async (organizationId) => inOrg(t.profiles, organizationId),
      createProfile: async (input) => {
        const row = { id: id('profile'), userId: input.userId ?? null, handle: input.handle ?? null, ...input };
        t.profiles.push(row);
        return row;
      },
      bindUser: async (organizationId, profileId, userId) => {
        const p = t.profiles.find((x) => x.organizationId === organizationId && x.id === profileId);
        if (p) p.userId = userId;
      },
      listAudience: async (organizationId, creatorProfileId) => inOrg(t.audience, organizationId).filter((a) => a.creatorProfileId === creatorProfileId),
      listPerformance: async (organizationId, creatorProfileId, filter = {}) =>
        inOrg(t.performance, organizationId).filter((p) => p.creatorProfileId === creatorProfileId && (!filter.platform || p.platform === filter.platform)),
      listCompensation: async (organizationId, creatorProfileId) => inOrg(t.compensation, organizationId).filter((c) => c.creatorProfileId === creatorProfileId),
      addAudience: async (data) => {
        t.audience.push({ id: id('aud'), ...data });
      },
      addPerformance: async (data) => {
        t.performance.push({ id: id('perf'), ...data });
      },
      addCompensation: async (data) => {
        t.compensation.push({ id: id('comp'), ...data });
      },
    },
    commercial: {
      listOpportunitiesForCreator: async (organizationId, creatorPartyId) => inOrg(t.opportunities, organizationId).filter((o) => o.creatorPartyId === creatorPartyId),
      createOpportunity: async (input) => {
        const row = { id: id('opp'), ...input };
        t.opportunities.push(row);
        return row;
      },
      listCampaignsForCreator: async (organizationId, creatorPartyId) => inOrg(t.campaigns, organizationId).filter((c) => c.creatorPartyId === creatorPartyId),
      createCampaign: async (input) => {
        const row = { id: id('camp'), state: input.state ?? 'DRAFT', ...input };
        t.campaigns.push(row);
        t.campaignTransitions.push({ campaignId: row.id, fromState: null, toState: row.state, note: 'Declared' });
        return row;
      },
      transitionCampaign: async (input) => {
        const c = t.campaigns.find((x) => x.organizationId === input.organizationId && x.id === input.campaignId);
        if (!c) return null;
        t.campaignTransitions.push({ campaignId: c.id, fromState: c.state, toState: input.toState, note: input.note ?? null, actorUserId: input.actorUserId });
        c.state = input.toState;
        return c;
      },
      listDeliverablesForCreator: async (organizationId, creatorPartyId) => inOrg(t.deliverables, organizationId).filter((d) => d.creatorPartyId === creatorPartyId),
      declareDeliverable: async (input) => {
        const row = { id: id('deliv'), ...input };
        t.deliverables.push(row);
        return row;
      },
    },
    productions: {
      ensureProductionWorkType: async (organizationId, createdByUserId) => {
        const existing = t.workTypes.find((w) => w.organizationId === organizationId);
        if (existing) return existing.id;
        const row = { id: id('wt'), organizationId, createdByUserId, catalogKey: 'creator-production' };
        t.workTypes.push(row);
        return row.id;
      },
    },
    now: () => NOW,
    mintToken: mintInviteToken,
    writeFile: async (path, content) => {
      files[path] = content;
    },
    log: (l) => lines.push(l),
  };
  const snapshot = () => JSON.stringify(t);
  return { deps, lines, files, t, snapshot };
}

function request(overrides: Partial<SeedRequest> = {}): SeedRequest {
  return {
    organizationSlug: ORG.slug,
    ownerEmail: 'matt@emg.test',
    creatorEmail: 'denise@creator.test',
    creatorName: DEFAULT_CREATOR_NAME,
    editorEmail: 'charlie@emg.test',
    appUrl: DEFAULT_APP_URL,
    inviteOut: null,
    dryRun: false,
    ...overrides,
  };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const tokenOf = (url: string) => new URL(url).searchParams.get('token') ?? '';

// --- Arguments and guards ----------------------------------------------------------------

test('parseArgs: required flags, documented defaults, --dry-run, and empty optionals', () => {
  const minimal = parseArgs(['--organization', 'emg-staging', '--owner-email', 'matt@emg.test', '--creator-email', 'denise@creator.test']);
  assert.deepEqual(minimal, {
    organization: 'emg-staging',
    ownerEmail: 'matt@emg.test',
    creatorEmail: 'denise@creator.test',
    creatorName: DEFAULT_CREATOR_NAME,
    editorEmail: '',
    appUrl: DEFAULT_APP_URL,
    inviteOut: '',
    dryRun: false,
  });
  const full = parseArgs(['--org', 'emg-staging', '--owner-email', 'a@b.co', '--creator-email', 'c@d.co', '--creator-name', 'Pat Lee', '--editor-email', 'e@f.co', '--app-url', 'https://x.test/', '--invite-out', '/tmp/x', '--dry-run']);
  assert.equal(full.creatorName, 'Pat Lee');
  assert.equal(full.editorEmail, 'e@f.co');
  assert.equal(full.appUrl, 'https://x.test/');
  assert.equal(full.inviteOut, '/tmp/x');
  assert.equal(full.dryRun, true);
  // The workflow passes optional inputs through unchanged: an empty value keeps the default.
  const empties = parseArgs(['--organization', 'x', '--owner-email', 'a@b.co', '--creator-email', 'c@d.co', '--creator-name', '', '--editor-email', '', '--app-url', '']);
  assert.equal(empties.creatorName, DEFAULT_CREATOR_NAME);
  assert.equal(empties.editorEmail, '');
  assert.equal(empties.appUrl, DEFAULT_APP_URL);
});

test('validateArgs refuses what is missing or malformed and normalises the rest', () => {
  const base = parseArgs(['--organization', 'emg-staging', '--owner-email', 'Matt@EMG.test', '--creator-email', 'Denise@Creator.test', '--app-url', 'https://x.test///']);
  const ok = validateArgs(base);
  assert.ok(ok.ok);
  assert.equal(ok.request.ownerEmail, 'matt@emg.test');
  assert.equal(ok.request.creatorEmail, 'denise@creator.test');
  assert.equal(ok.request.appUrl, 'https://x.test');
  assert.equal(ok.request.editorEmail, null);
  assert.equal(ok.request.inviteOut, null);
  for (const [bad, needle] of [
    [{ organization: '' }, '--organization'],
    [{ organization: 'EMG' }, '--organization'],
    [{ ownerEmail: '' }, '--owner-email'],
    [{ creatorEmail: 'nope' }, '--creator-email'],
    [{ editorEmail: 'nope' }, '--editor-email'],
    [{ creatorEmail: 'matt@emg.test' }, 'creator email must not be the owner'],
    [{ editorEmail: 'denise@creator.test' }, 'editor email must not be the creator'],
    [{ creatorName: '  ' }, '--creator-name'],
    [{ appUrl: 'staging.netlify.app' }, '--app-url'],
    [{ appUrl: 'ftp://x' }, '--app-url'],
  ] as const) {
    const r = validateArgs({ ...base, ...bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    if (!r.ok) assert.match(r.reason, new RegExp(needle));
  }
});

test('the target guard needs BOTH a Neon/local host AND LOOP_SEED_TARGET=staging', () => {
  const neon = 'postgresql://user:pw@ep-cool-name-123456.us-east-1.aws.neon.tech/neondb?sslmode=require';
  assert.deepEqual(checkTarget({ DATABASE_URL: neon, LOOP_SEED_TARGET: 'staging' } as NodeJS.ProcessEnv), { ok: true });
  assert.deepEqual(checkTarget({ DATABASE_URL: 'postgres://u:p@localhost:5432/loop', LOOP_SEED_TARGET: 'staging' } as NodeJS.ProcessEnv), { ok: true });
  assert.deepEqual(checkTarget({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/loop', LOOP_SEED_TARGET: 'staging' } as NodeJS.ProcessEnv), { ok: true });
  const refused = (env: Record<string, string | undefined>) => {
    const r = checkTarget(env as NodeJS.ProcessEnv);
    assert.equal(r.ok, false, JSON.stringify(env));
    return r.ok ? '' : r.reason;
  };
  assert.equal(refused({ LOOP_SEED_TARGET: 'staging' }), 'DATABASE_URL_MISSING');
  assert.equal(refused({ DATABASE_URL: '   ', LOOP_SEED_TARGET: 'staging' }), 'DATABASE_URL_MISSING');
  assert.equal(refused({ DATABASE_URL: 'not a url', LOOP_SEED_TARGET: 'staging' }), 'DATABASE_URL_UNPARSEABLE');
  assert.equal(refused({ DATABASE_URL: 'https://ep-x.neon.tech/db', LOOP_SEED_TARGET: 'staging' }), 'DATABASE_URL_NOT_POSTGRES');
  assert.equal(refused({ DATABASE_URL: 'postgresql://u:p@prod-db.cluster-abc.us-east-1.rds.amazonaws.com/loop', LOOP_SEED_TARGET: 'staging' }), 'DATABASE_HOST_NOT_ALLOWED');
  assert.equal(refused({ DATABASE_URL: 'postgresql://u:p@neon.tech.evil.example/loop', LOOP_SEED_TARGET: 'staging' }), 'DATABASE_HOST_NOT_ALLOWED');
  assert.equal(refused({ DATABASE_URL: 'postgresql://u:p@db.example.com/loop', LOOP_SEED_TARGET: 'staging' }), 'DATABASE_HOST_NOT_ALLOWED');
  // The host alone is never enough: production is on Neon too.
  assert.equal(refused({ DATABASE_URL: neon }), 'LOOP_SEED_TARGET_NOT_STAGING');
  assert.equal(refused({ DATABASE_URL: neon, LOOP_SEED_TARGET: '' }), 'LOOP_SEED_TARGET_NOT_STAGING');
  assert.equal(refused({ DATABASE_URL: neon, LOOP_SEED_TARGET: 'production' }), 'LOOP_SEED_TARGET_NOT_STAGING');
  assert.equal(refused({ DATABASE_URL: neon, LOOP_SEED_TARGET: 'Staging' }), 'LOOP_SEED_TARGET_NOT_STAGING');
  assert.equal(refused({ DATABASE_URL: 'postgresql://u:p@localhost/loop', LOOP_SEED_TARGET: 'production' }), 'LOOP_SEED_TARGET_NOT_STAGING');
  assert.ok(!ALLOWED_DB_HOST.test('prod.example.com'));
});

test('the invitation token has the shape auth.ts mints: 32 random bytes hex, stored as its sha256', () => {
  const a = mintInviteToken();
  const b = mintInviteToken();
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.equal(a.tokenHash, sha256(a.token));
  assert.notEqual(a.token, b.token);
  assert.equal(acceptUrlFor('https://x.test/', a.token), `https://x.test/crm/accept-invite?token=${a.token}`);
});

// --- The plan ---------------------------------------------------------------------------

test('the evidence is deterministic: twelve Monday-anchored weeks, strictly growing followers, views in range', () => {
  const once = evidencePlan(NOW);
  const twice = evidencePlan(new Date(NOW.getTime()));
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
  // Weekly rows are anchored to the Monday, so another day of the same week keys identically;
  // compensation dates are day-anchored, and those rows are keyed by description instead.
  const later = evidencePlan(new Date('2026-09-25T02:00:00.000Z'));
  assert.equal(JSON.stringify([later.audience, later.performance]), JSON.stringify([once.audience, once.performance]), 'the same week gives the same weekly rows');
  assert.deepEqual(later.compensation.map((c) => c.description), once.compensation.map((c) => c.description));

  assert.equal(once.audience.length, EVIDENCE_WEEKS);
  assert.equal(once.performance.length, EVIDENCE_WEEKS);
  assert.equal(once.audience[0]!.followers, AUDIENCE_START);
  assert.equal(once.audience[EVIDENCE_WEEKS - 1]!.followers, AUDIENCE_END);
  for (let i = 1; i < once.audience.length; i += 1) assert.ok(once.audience[i]!.followers > once.audience[i - 1]!.followers, `week ${i} grows`);
  assert.deepEqual(once.audience.map((a) => a.growth30dPct), [...Array(EVIDENCE_WEEKS - 1).fill(null), 4.2]);

  const anchor = weekAnchor(NOW);
  assert.equal(anchor.toISOString(), '2026-09-21T00:00:00.000Z', 'the Monday on or before a Wednesday');
  assert.equal(weekAnchor(new Date('2026-09-21T00:00:00.000Z')).toISOString(), '2026-09-21T00:00:00.000Z');
  assert.equal(weekAnchor(new Date('2026-09-20T23:59:59.000Z')).toISOString(), '2026-09-14T00:00:00.000Z');
  assert.equal(once.audience[EVIDENCE_WEEKS - 1]!.observedAt.toISOString(), anchor.toISOString());
  for (let i = 0; i < once.performance.length; i += 1) {
    const p = once.performance[i]!;
    assert.equal(p.windowEnd.getTime() - p.windowStart.getTime(), 7 * 86_400_000);
    assert.equal(p.windowEnd.getTime(), anchor.getTime() - (EVIDENCE_WEEKS - 1 - i) * 7 * 86_400_000);
    assert.equal(p.observedAt.getTime(), p.windowEnd.getTime());
    assert.equal(p.contentId, null);
    assert.equal(p.platform, 'INSTAGRAM');
    assert.equal(p.source, 'SEEDED_DEMO');
    assert.ok(p.metrics.views >= 8_000 && p.metrics.views <= 16_000, `views ${p.metrics.views}`);
    for (const k of ['views', 'reach', 'likes', 'comments', 'saves', 'shares', 'completionPct'] as const) assert.ok(Number.isInteger(p.metrics[k]) && p.metrics[k] > 0, k);
    assert.ok(p.metrics.reach < p.metrics.views);
    assert.ok(p.metrics.completionPct > 0 && p.metrics.completionPct <= 100);
  }
  assert.ok(once.audience.every((a) => a.source === 'SEEDED_DEMO' && a.platform === 'INSTAGRAM'));

  assert.deepEqual(
    once.compensation.map((c) => [c.description, c.amountMinor, c.state, c.currency, c.source]),
    [
      [`${KONA_CAMPAIGN_NAME} — ${REEL_1_TITLE}`, 175_000, 'EXPECTED', 'USD', 'SEEDED_DEMO'],
      [`${KONA_CAMPAIGN_NAME} — ${REEL_2_TITLE}`, 175_000, 'EXPECTED', 'USD', 'SEEDED_DEMO'],
      ['Sun & Soil — spring series (completed)', 240_000, 'PAID', 'USD', 'SEEDED_DEMO'],
      ['Sun & Soil — bonus reach', 50_000, 'AVAILABLE', 'USD', 'SEEDED_DEMO'],
      ['Meadow Skincare — March reel', 120_000, 'RECEIVED_BY_EMG', 'USD', 'SEEDED_DEMO'],
    ],
  );
  const day = (d: Date) => Math.round((d.getTime() - Date.UTC(2026, 8, 23)) / 86_400_000);
  assert.deepEqual(once.compensation.map((c) => day(c.occurredAt)), [4, 18, -40, -12, -6]);
});

test('the commercial plan carries the agreed dates, requirements and designations', () => {
  const plan = commercialPlan(NOW);
  const day = (d: Date | null | undefined) => (d ? Math.round((d.getTime() - Date.UTC(2026, 8, 23)) / 86_400_000) : null);
  assert.equal(plan.kona.stage, 'Confirmed');
  assert.equal(plan.kona.creatorVisibleState, 'CONFIRMED');
  assert.equal(plan.kona.brandVisibleToCreator, true);
  assert.equal(plan.kona.amountMinor, 350_000);
  assert.equal(plan.sculpey.creatorVisibleState, 'PITCHING');
  assert.equal(plan.sculpey.brandVisibleToCreator, false);
  assert.equal(plan.campaign.name, KONA_CAMPAIGN_NAME);
  assert.equal(plan.campaignState, 'ACTIVE');
  assert.deepEqual([day(plan.campaign.startDate), day(plan.campaign.endDate)], [0, 30]);
  assert.deepEqual(plan.deliverables.map((d) => [d.title, d.deliverableType, day(d.dueAt), d.acceptsUnedited]), [
    [REEL_1_TITLE, 'REEL', 4, false],
    [REEL_2_TITLE, 'REEL', 18, true],
  ]);
  const keys = (r: unknown) => (r as { key: string; label: string; required: boolean }[]).map((x) => `${x.key}:${x.required}`);
  assert.deepEqual(keys(plan.deliverables[0]!.requirements), ['creator:true', 'emg:true', 'brand:true', 'published:true']);
  assert.deepEqual(keys(plan.deliverables[1]!.requirements), ['creator:true', 'emg:true', 'published:true']);
  assert.equal((plan.deliverables[0]!.requirements as { label: string }[])[2]!.label, "Kona's approval");
  assert.deepEqual(handlesFor('Denise Rivera'), { instagram: '@denise.rivera', tiktok: '@deniserivera', youtube: 'Denise Rivera' });
  assert.deepEqual(handlesFor("  Pat O'Neil  "), { instagram: '@pat.oneil', tiktok: '@patoneil', youtube: "Pat O'Neil" });
});

// --- The run ----------------------------------------------------------------------------

test('a fresh run creates everything through the governed paths and prints the accept link once', async () => {
  const { deps, lines, t } = world();
  const r = await runSeed(request(), deps);
  assert.equal(r.overall, 'SEEDED', r.error ?? '');
  assert.equal(r.login, 'INVITED');
  assert.deepEqual(r.steps, {
    PARTY: 'CREATED',
    PARTY_ESTABLISHED: 'CREATED',
    RELATIONSHIP: 'CREATED',
    LOGIN: 'CREATED',
    PROFILE: 'CREATED',
    OPPORTUNITY_KONA: 'CREATED',
    CAMPAIGN_KONA: 'CREATED',
    DELIVERABLE_REEL_1: 'CREATED',
    DELIVERABLE_REEL_2: 'CREATED',
    OPPORTUNITY_SCULPEY: 'CREATED',
    WORK_TYPE: 'CREATED',
  });
  assert.deepEqual(r.evidence, {
    audience: { created: 12, reused: 0, wouldCreate: 0 },
    performance: { created: 12, reused: 0, wouldCreate: 0 },
    compensation: { created: 5, reused: 0, wouldCreate: 0 },
  });

  // The Party: PERSON, established MANUAL, by the owner.
  assert.equal(t.parties.length, 1);
  assert.deepEqual([t.parties[0]!.partyType, t.parties[0]!.displayName, t.parties[0]!.established, t.parties[0]!.basis], ['PERSON', 'Denise Rivera', true, 'MANUAL']);
  // The relationship: TALENT_REPRESENTATION with the creator as COUNTERPARTY in the CREATOR capacity.
  assert.equal(t.relationships.length, 1);
  assert.deepEqual([t.relationships[0]!.kind, t.relationships[0]!.state, t.relationships[0]!.partyId, t.relationships[0]!.role, t.relationships[0]!.occurredAt], ['TALENT_REPRESENTATION', 'ACTIVE', t.parties[0]!.id, 'CREATOR', NOW]);
  // The login: INVITED as CREATOR, invited by the owner, one PENDING invitation whose hash is sha256 of the printed token, +14 days.
  const creator = t.users.find((u) => u.email === 'denise@creator.test')!;
  const owner = t.users.find((u) => u.email === 'matt@emg.test')!;
  assert.deepEqual([creator.status, creator.role, creator.name, creator.invitedByUserId], ['INVITED', 'CREATOR', 'Denise Rivera', owner.id]);
  assert.equal(t.invitations.length, 1);
  const inv = t.invitations[0]!;
  assert.deepEqual([inv.status, inv.role, inv.invitedById, inv.email], ['PENDING', 'CREATOR', owner.id, 'denise@creator.test']);
  assert.equal(inv.expiresAt.getTime(), NOW.getTime() + 14 * 86_400_000);
  assert.ok(r.acceptUrl);
  assert.ok(r.acceptUrl!.startsWith(`${DEFAULT_APP_URL}/crm/accept-invite?token=`));
  assert.equal(sha256(tokenOf(r.acceptUrl!)), inv.tokenHash);
  assert.deepEqual(t.revokedSessionsFor, [], 'a brand-new row had no sessions to revoke');
  const invited = t.audits.filter((a) => a.action === 'user.invited');
  assert.equal(invited.length, 1);
  assert.deepEqual([invited[0]!.userId, invited[0]!.actorName, invited[0]!.entityId, invited[0]!.metadata.role], [owner.id, 'Matt', creator.id, 'CREATOR']);
  // The profile: bound to the login, on the Party, editor = Charlie, created by the owner, the agreed shape.
  assert.equal(t.profiles.length, 1);
  const p = t.profiles[0]!;
  assert.deepEqual(
    [p.userId, p.partyId, p.defaultEditorUserId, p.createdByUserId, p.displayName, p.handle, p.categories, p.payoutState],
    [creator.id, t.parties[0]!.id, t.users.find((u) => u.email === 'charlie@emg.test')!.id, owner.id, 'Denise Rivera', '@denise.rivera', ['Lifestyle', 'Pets', 'Home'], 'NOT_SET_UP'],
  );
  assert.deepEqual(p.socialAccounts, [
    { platform: 'INSTAGRAM', handle: '@denise.rivera', state: 'SEEDED_DEMO' },
    { platform: 'TIKTOK', handle: '@deniserivera', state: 'NOT_CONNECTED' },
    { platform: 'YOUTUBE', handle: 'Denise Rivera', state: 'NOT_CONNECTED' },
  ]);
  assert.deepEqual(p.rateInfo, { visibleToCreator: true, reelFromUsd: 1500 });
  assert.equal(r.creatorProfileId, p.id);
  // Commercial: two opportunities on the Party, the campaign ACTIVE by transition, two deliverables.
  assert.deepEqual(t.opportunities.map((o) => [o.title, o.stage, o.creatorVisibleState, o.brandVisibleToCreator, o.creatorPartyId, o.relationshipId, o.createdByUserId]), [
    ['Kona — product video', 'Confirmed', 'CONFIRMED', true, t.parties[0]!.id, t.relationships[0]!.id, owner.id],
    ['Sculpey — holiday series', 'Pitching', 'PITCHING', false, t.parties[0]!.id, t.relationships[0]!.id, owner.id],
  ]);
  assert.equal(t.campaigns.length, 1);
  assert.deepEqual([t.campaigns[0]!.name, t.campaigns[0]!.state, t.campaigns[0]!.opportunityId, t.campaigns[0]!.brandVisibleToCreator], ['Kona Product Video', 'ACTIVE', t.opportunities[0]!.id, true]);
  assert.deepEqual(t.campaignTransitions.map((x) => [x.fromState, x.toState]), [[null, 'DRAFT'], ['DRAFT', 'ACTIVE']]);
  assert.deepEqual(t.deliverables.map((d) => [d.title, d.campaignId, d.acceptsUnedited]), [['Reel 1 of 2', t.campaigns[0]!.id, false], ['Reel 2 of 2', t.campaigns[0]!.id, true]]);
  // Evidence: all SEEDED_DEMO, on the profile; the Kona compensation points at the campaign and its deliverable.
  assert.ok([...t.audience, ...t.performance, ...t.compensation].every((row) => row.source === 'SEEDED_DEMO' && row.creatorProfileId === p.id && row.organizationId === ORG.id));
  assert.deepEqual(
    t.compensation.map((c) => [c.campaignId, c.deliverableId]),
    [[t.campaigns[0]!.id, t.deliverables[0]!.id], [t.campaigns[0]!.id, t.deliverables[1]!.id], [null, null], [null, null], [null, null]],
  );
  assert.equal(t.workTypes.length, 1);

  // The accept link is printed exactly once, in the summary, and the token nowhere else.
  const out = lines.join('\n');
  assert.equal(out.split(r.acceptUrl!).length - 1, 1);
  assert.equal(out.split(tokenOf(r.acceptUrl!)).length - 1, 1);
  assert.match(out, /event=VERDICT OVERALL=SEEDED CREATED=11 REUSED=0 WOULD_CREATE=0 WROTE=true/);
  assert.match(out, /Creator profile id:\s+profile_\d+/);
  assert.match(out, /\/app\/creator\/content/);
});

test('a rerun reuses everything, adds no row, and only supersedes the pending invitation', async () => {
  const { deps, lines, t } = world();
  const first = await runSeed(request(), deps);
  const counts = () => JSON.stringify(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Array.isArray(v) ? v.length : v])));
  const before = counts();
  lines.length = 0;
  const again = await runSeed(request(), deps);
  assert.equal(again.overall, 'SEEDED', again.error ?? '');
  assert.equal(again.login, 'REINVITED');
  const expected = Object.fromEntries(Object.keys(first.steps).map((k) => [k, k === 'LOGIN' || k === 'WORK_TYPE' ? 'CREATED' : 'REUSED']));
  assert.deepEqual(again.steps, expected);
  assert.deepEqual(again.evidence, {
    audience: { created: 0, reused: 12, wouldCreate: 0 },
    performance: { created: 0, reused: 12, wouldCreate: 0 },
    compensation: { created: 0, reused: 5, wouldCreate: 0 },
  });
  // Only the invitation table grew (plus its audit row): the old token is REVOKED, exactly one is PENDING, and it is a new one.
  const after = JSON.parse(counts());
  const was = JSON.parse(before);
  // (revokedSessionsFor is the log of the one session revocation a reinstated row gets, asserted below.)
  for (const k of Object.keys(was)) assert.equal(after[k], k === 'invitations' || k === 'audits' || k === 'revokedSessionsFor' ? was[k] + 1 : was[k], k);
  assert.equal(t.audits.filter((a) => a.action === 'user.invited').length, 2);
  assert.deepEqual(t.invitations.map((i) => i.status), ['REVOKED', 'PENDING']);
  assert.notEqual(again.acceptUrl, first.acceptUrl);
  assert.equal(sha256(tokenOf(again.acceptUrl!)), t.invitations[1]!.tokenHash);
  // The reinstated row's sessions are revoked, as the Team page does on re-invitation.
  const creator = t.users.find((u) => u.email === 'denise@creator.test')!;
  assert.deepEqual(t.revokedSessionsFor, [creator.id]);
  assert.equal(t.users.length, 3, 'no second user row');
  assert.equal(t.parties.length, 1, 'no second Party');
  assert.equal(t.profiles.length, 1, 'no second profile');
  assert.match(lines.join('\n'), /event=STEP step=LOGIN action=CREATED mode=REINVITED SUPERSEDED_INVITATIONS=1/);
  // And a third run behaves the same way: the set never grows beyond one live token.
  await runSeed(request(), deps);
  assert.deepEqual(t.invitations.map((i) => i.status), ['REVOKED', 'REVOKED', 'PENDING']);
});

test('once the creator has accepted, a rerun issues no invitation and says to use the existing password', async () => {
  const { deps, lines, t } = world();
  await runSeed(request(), deps);
  const creator = t.users.find((u) => u.email === 'denise@creator.test')!;
  creator.status = 'ACTIVE';
  t.invitations[0]!.status = 'ACCEPTED';
  const before = JSON.stringify(t);
  lines.length = 0;
  const r = await runSeed(request(), deps);
  assert.equal(r.overall, 'SEEDED');
  assert.equal(r.login, 'EXISTING_ACTIVE');
  assert.equal(r.acceptUrl, null);
  assert.equal(r.steps.LOGIN, 'REUSED');
  assert.equal(r.steps.PROFILE, 'REUSED');
  assert.equal(JSON.stringify(t), before, 'nothing written');
  assert.match(lines.join('\n'), /existing password/);
  assert.ok(!lines.join('\n').includes('accept-invite?token='));
});

test('a profile left unbound by a partial run is found by handle, its Party reused, and the new login bound to it', async () => {
  const { deps, t } = world();
  // A Party and an unbound profile exist; nothing else does.
  const party = { id: 'party_orphan', organizationId: ORG.id, partyType: 'PERSON', displayName: 'Denise Rivera', established: true, basis: 'MANUAL' };
  t.parties.push(party);
  t.profiles.push({ id: 'profile_orphan', organizationId: ORG.id, partyId: party.id, userId: null, handle: '@denise.rivera', displayName: 'Denise Rivera' });
  const r = await runSeed(request(), deps);
  assert.equal(r.overall, 'SEEDED', r.error ?? '');
  assert.deepEqual([r.steps.PARTY, r.steps.PARTY_ESTABLISHED, r.steps.PROFILE, r.steps.RELATIONSHIP], ['REUSED', 'REUSED', 'REUSED', 'CREATED']);
  assert.equal(t.parties.length, 1);
  assert.equal(t.profiles.length, 1);
  const creator = t.users.find((u) => u.email === 'denise@creator.test')!;
  assert.equal(t.profiles[0]!.userId, creator.id, 'bound to the new login');
  assert.equal(r.creatorProfileId, 'profile_orphan');
  assert.equal(t.audience.length, 12);
});

test('an ENDED relationship holds the natural key: the seed does not reopen it and carries on', async () => {
  const { deps, t } = world();
  await runSeed(request(), deps);
  t.relationships[0]!.state = 'ENDED';
  const r = await runSeed(request(), deps);
  assert.equal(r.overall, 'SEEDED');
  assert.equal(r.steps.RELATIONSHIP, 'SKIPPED');
  assert.equal(t.relationships.length, 1);
  assert.equal(t.relationships[0]!.state, 'ENDED');
});

test('every refusal happens before any write', async () => {
  const cases: Array<[string, Partial<SeedRequest>, Parameters<typeof world>[0], RegExp]> = [
    ['unknown organization', { organizationSlug: 'nope' }, {}, /unknown organization/],
    ['malformed slug', { organizationSlug: 'EMG' }, {}, /lowercase/],
    ['owner not a member', { ownerEmail: 'stranger@emg.test' }, {}, /owner email is not a member/],
    ['owner invited, not active', {}, { users: [{ email: 'matt@emg.test', status: 'INVITED', role: 'OWNER' }] }, /not an ACTIVE member/],
    ['owner is an EMPLOYEE', {}, { users: [{ email: 'matt@emg.test', status: 'ACTIVE', role: 'EMPLOYEE' }] }, /holds EMPLOYEE; an OWNER or ADMIN/],
    ['owner is a MANAGER', {}, { users: [{ email: 'matt@emg.test', status: 'ACTIVE', role: 'MANAGER' }] }, /holds MANAGER/],
    ['editor unknown', { editorEmail: 'nobody@emg.test' }, {}, /editor email is not an ACTIVE member/],
    ['editor disabled', {}, { users: [{ email: 'matt@emg.test', status: 'ACTIVE', role: 'OWNER' }, { email: 'charlie@emg.test', status: 'DISABLED', role: 'EMPLOYEE' }] }, /editor email is not an ACTIVE member/],
    ['creator email is an ACTIVE employee', {}, { users: [{ email: 'matt@emg.test', status: 'ACTIVE', role: 'OWNER' }, { email: 'charlie@emg.test', status: 'ACTIVE', role: 'EMPLOYEE' }, { email: 'denise@creator.test', status: 'ACTIVE', role: 'EMPLOYEE' }] }, /ACTIVE EMPLOYEE member; the creator seat needs a CREATOR login/],
    ['creator email is a DISABLED member', {}, { users: [{ email: 'matt@emg.test', status: 'ACTIVE', role: 'OWNER' }, { email: 'charlie@emg.test', status: 'ACTIVE', role: 'EMPLOYEE' }, { email: 'denise@creator.test', status: 'DISABLED', role: 'CREATOR' }] }, /DISABLED or removed member; this seed never resurrects/],
  ];
  for (const [name, overrides, setup, reason] of cases) {
    const { deps, t, lines } = world(setup);
    const before = JSON.stringify(t);
    const r = await runSeed(request(overrides), deps);
    assert.equal(r.overall, 'FAILED_PRECONDITION', name);
    assert.match(r.error ?? '', reason, name);
    assert.equal(JSON.stringify(t), before, `${name}: nothing written`);
    assert.match(lines.join('\n'), /event=PRECONDITION_FAILED .*WROTE=false/);
  }
});

test('an ADMIN owner may record the seed too', async () => {
  const { deps } = world({ users: [{ email: 'matt@emg.test', status: 'ACTIVE', role: 'ADMIN', name: 'Matt' }, { email: 'charlie@emg.test', status: 'ACTIVE', role: 'EMPLOYEE' }] });
  const r = await runSeed(request(), deps);
  assert.equal(r.overall, 'SEEDED', r.error ?? '');
});

test('a dry run reports the plan and writes nothing, on a fresh and on a seeded organization', async () => {
  const fresh = world();
  const before = fresh.snapshot();
  const plan = await runSeed(request({ dryRun: true }), fresh.deps);
  assert.equal(plan.overall, 'DRY_RUN');
  assert.equal(plan.login, 'WOULD_INVITE');
  assert.equal(plan.acceptUrl, null);
  assert.ok(Object.values(plan.steps).every((a) => a === 'WOULD_CREATE'), JSON.stringify(plan.steps));
  assert.deepEqual(plan.evidence, {
    audience: { created: 0, reused: 0, wouldCreate: 12 },
    performance: { created: 0, reused: 0, wouldCreate: 12 },
    compensation: { created: 0, reused: 0, wouldCreate: 5 },
  });
  assert.equal(fresh.snapshot(), before);
  assert.match(fresh.lines.join('\n'), /event=VERDICT OVERALL=DRY_RUN CREATED=0 REUSED=0 WOULD_CREATE=11 WROTE=false/);

  const seeded = world();
  await runSeed(request(), seeded.deps);
  const seededBefore = seeded.snapshot();
  const again = await runSeed(request({ dryRun: true }), seeded.deps);
  assert.equal(again.overall, 'DRY_RUN');
  assert.equal(again.steps.PARTY, 'REUSED');
  assert.equal(again.steps.PROFILE, 'REUSED');
  assert.equal(again.steps.LOGIN, 'WOULD_CREATE', 'a still-pending invitation would be superseded');
  assert.deepEqual(again.evidence.audience, { created: 0, reused: 12, wouldCreate: 0 });
  assert.equal(seeded.snapshot(), seededBefore);
});

test('with --invite-out the accept link goes to the file and never into the log', async () => {
  const { deps, lines, files } = world();
  const r = await runSeed(request({ inviteOut: '/runner/tmp/creator-invite.txt' }), deps);
  assert.equal(r.overall, 'SEEDED');
  assert.ok(r.acceptUrl);
  assert.equal(files['/runner/tmp/creator-invite.txt'], r.acceptUrl + '\n');
  const out = lines.join('\n');
  assert.ok(!out.includes(tokenOf(r.acceptUrl!)), 'the token is not in the log');
  assert.ok(!out.includes('accept-invite?token='));
  assert.match(out, /written to \/runner\/tmp\/creator-invite\.txt; it is not in this log/);
});

// --- Source and workflow shape ------------------------------------------------------------

test('the runner writes only through the governed paths, with no randomness in the evidence', () => {
  for (const governed of ['deps.parties.create(', 'deps.parties.establish(', 'deps.relationshipService.create(', 'deps.iam.prepareInvitation(', 'deps.iam.createInvitation(', 'deps.auth.revokeAllForUser(', 'deps.audit.record(', 'deps.productions.ensureProductionWorkType(']) {
    assert.ok(RUNNER_CODE.includes(governed), `runner uses ${governed}`);
  }
  for (const forbidden of ['Math.random', '$executeRaw', '$queryRaw', 'activateUser', 'updateUserRole', 'setPasswordHash', 'fetch(']) {
    assert.ok(!RUNNER_CODE.includes(forbidden), `runner must not name ${forbidden}`);
  }
  assert.ok(!/prisma\.\w+\.(create|update|upsert|delete|findFirst|findMany)/.test(RUNNER_CODE), 'the runner goes through repositories and services');
  assert.ok(RUNNER_CODE.indexOf('checkTarget(process.env)') < RUNNER_CODE.indexOf("import('@emgloop/database')"), 'the guards run before the client loads');
});

test('the workflow is human-dispatched, staging-only, reads no production secret, and interpolates no input', () => {
  assert.ok(WORKFLOW.includes('workflow_dispatch:'));
  for (const trigger of ['\n  schedule:', '\n  push:', '\n  pull_request:', '\n  workflow_call:']) assert.ok(!WORKFLOW.includes(trigger), trigger);
  assert.ok(WORKFLOW.includes('environment: connections-staging'));
  assert.ok(WORKFLOW.includes("STAGING_DB_SECRET: 'loop/connections/staging/database-url'"));
  assert.ok(WORKFLOW.includes('vars.CONNECTIONS_STAGING_MIGRATE_ROLE_ARN'));
  assert.ok(WORKFLOW.includes("allowed-account-ids: '065148797865'"));
  assert.ok(WORKFLOW.includes('LOOP_SEED_TARGET: staging'));
  assert.ok(WORKFLOW.includes("inputs.confirm != 'seed loop-connections-staging'"));
  assert.ok(!/secrets\.DIRECT_DATABASE_URL|secrets\.DATABASE_URL/.test(WORKFLOW), 'never the production secret');
  assert.ok(!WORKFLOW.includes('::notice::'), 'the link is not a notice anyone with repo read sees in the log');
  assert.ok(WORKFLOW.includes('GITHUB_STEP_SUMMARY'));
  assert.ok(WORKFLOW.includes('--invite-out "${INVITE_OUT}"'));
  assert.ok(WORKFLOW.indexOf('test:operations') < WORKFLOW.indexOf('configure-aws-credentials'), 'proves itself before it holds a credential');
  for (const body of WORKFLOW.split(/\n\s+run: \|/).slice(1)) {
    const step = body.split(/\n\s+- name:/)[0] ?? '';
    assert.ok(!/\$\{\{\s*inputs\./.test(step), 'no input interpolated into a run body');
  }
});
