// The front door's additive reads, for one signed-in person. SERVER ONLY.
//
// Loop Home COMPOSES existing authorities and never becomes one. Every read below is a read some
// page of Loop already makes, through the same repository or service, under the same organization:
// the Command Center's context and the Overview's own analysis (admin/marketplace/command-data.ts,
// executive-data.ts), the person's own chats and their own Chats intelligence digests as the Chats
// page reads them (daily-loop/chats.ts), the CRM repository's intake counts, the creator roster the
// Creators page draws, and the investigation behind a Headline. Home itself writes nothing. (The
// Overview's analysis records what the CallGrid engine detected in the Decision Engine, idempotently
// per analysis period -- the same record the Overview, Intelligence and the scheduled detection pass
// make; Home owns no table of its own.)
//
// GATED BY THE NAVIGATION THIS PERSON WAS OFFERED. A domain is read only when its destination is in
// the resolved nav groups (permissions and role authority, fail closed) -- and the pages behind
// those destinations still enforce their own authority on arrival. The executive reads (CallGrid,
// creators) are made only for the executive Home, whatever the groups say.
//
// ONE CALLGRID CONTEXT. The KPI row and the CallGrid tile's brief are two readings of ONE context,
// read once: the row is the contract's KPIs over it, the brief is the Overview's own
// `executiveBrief` over the engine's READING of it (`loadExecutiveReading`: reads only -- Home never
// records a detection). The reading settles on its own, so an engine that cannot run leaves the KPI
// row standing.
//
// THE ORGANIZATION AND THE PERSON COME FROM THE SIGNED SESSION, and every read settles on its own: a
// domain that cannot be read becomes its tile's honest state, never a Home that fails to render.

import 'server-only';

import { absentUntilMigrated, type WorkPrincipal } from '@emgloop/database';
import { callGridKpis, type CallGridBrief, type TimeView } from '@emgloop/shared';

import type { AuthSession } from '../../../auth/auth';
import { creatorDomain } from '../../../creator/creator-runtime';
import { crmRepos } from '../../../crm/crm-data';
import { loadChatsInput } from '../../../daily-loop/chats';
import type { ChatsIntelligenceInput } from '../../../daily-loop/chats-intelligence';
import type { NeedsYouItem } from '../../../daily-loop/needs-you';
import type { NavGroup } from '../../../workspaces/config';
import { loadCasesForHeadlines } from '../admin/headlines/headlines-data';
import { loadCommandContextFor, type CommandContext } from '../admin/marketplace/command-data';
import { executiveBrief, loadExecutiveReading } from '../admin/marketplace/executive-data';
import { headlineSituation, type HeadlineSituation, type HeadlineView } from '@emgloop/shared';
import { HOME_KPI_KEYS, projectHomeKpis, type HomeKpiStrip } from './kpis';
import { settle, type Settled } from './settle';
import { TILE_PATHS, type HomeTile, type RosterRowInput } from './tiles';
import { loadOrganizationReading, loadPrincipalReading } from '../../../intelligence/domain-reading';
import type { DomainProjection, IntelligenceDomain } from '@emgloop/shared';

/** Whether the rail this person was offered leads to `href`. Nav visibility, not authorization. */
export function navOffers(groups: readonly NavGroup[], href: string): boolean {
  return groups.some((g) => g.items.some((i) => !i.soon && i.href === href));
}

export interface FrontDoorReads {
  /** The Command Center's context, projected; null when CallGrid is not offered to this person. */
  readonly callgrid: Settled<HomeKpiStrip> | null;
  /**
   * The Overview's own brief over the SAME context (health band, its reason, what changed); null when
   * CallGrid is not offered or the context itself could not be read; `ok: false` when the analysis failed.
   */
  readonly callgridBrief: Settled<CallGridBrief> | null;
  /**
   * The viewer's own chats, as the Chats page reads them -- the connection, their own current CHATS
   * digests (`loadChatsDigests`, principal-scoped, settled on its own inside the read), activity and
   * their obligations; null when Chats is not offered.
   */
  readonly chats: Settled<ChatsIntelligenceInput> | null;
  /** Intake records per status; null when the Intake Board is not offered. */
  readonly intake: Settled<Readonly<Record<string, number>>> | null;
  /** The creator roster; `value: null` while its migration has not reached this database; null when not offered. */
  readonly creators: Settled<readonly RosterRowInput[] | null> | null;
  /**
   * Loop Intelligence: each offered domain's stored reading, projected -- the SAME artifact its page shows.
   * Personal domains read as the session's own principal; organization domains only with the domain's
   * registry read authority. A read that fails settles to nothing (the tile keeps its own figures).
   */
  readonly readings: Partial<Record<HomeTile['key'], DomainProjection>>;
}

/** Which tile shows which domain's reading, and at what scope. */
const TILE_READINGS: readonly { readonly key: HomeTile['key']; readonly href: string; readonly domain: IntelligenceDomain; readonly scope: 'PRINCIPAL' | 'ORGANIZATION'; readonly executiveOnly: boolean }[] = [
  { key: 'mail', href: TILE_PATHS.mail, domain: 'MAIL', scope: 'PRINCIPAL', executiveOnly: false },
  { key: 'calendar', href: TILE_PATHS.calendar, domain: 'CALENDAR', scope: 'PRINCIPAL', executiveOnly: false },
  { key: 'intake', href: TILE_PATHS.intake, domain: 'PIPELINE', scope: 'ORGANIZATION', executiveOnly: false },
  { key: 'callgrid', href: TILE_PATHS.marketplace, domain: 'CALLGRID', scope: 'ORGANIZATION', executiveOnly: true },
  { key: 'campaigns', href: TILE_PATHS.marketplace, domain: 'CAMPAIGNS', scope: 'ORGANIZATION', executiveOnly: true },
  { key: 'creators', href: TILE_PATHS.creators, domain: 'CREATORS', scope: 'ORGANIZATION', executiveOnly: true },
];

async function loadTileReadings(session: AuthSession, groups: readonly NavGroup[], now: Date, executive: boolean): Promise<Partial<Record<HomeTile['key'], DomainProjection>>> {
  const out: Partial<Record<HomeTile['key'], DomainProjection>> = {};
  await Promise.all(
    TILE_READINGS.filter((t) => navOffers(groups, t.href) && (executive || !t.executiveOnly)).map(async (t) => {
      const read = await settle(async () =>
        t.scope === 'PRINCIPAL' ? loadPrincipalReading(session, t.domain, { now, connectionLive: true }) : loadOrganizationReading(session, t.domain, { now }),
      );
      if (read.ok && read.value && read.value.projection.state !== 'NONE') out[t.key] = read.value.projection;
    }),
  );
  // Work: the organization's reading on the executive Home, the person's own elsewhere.
  const work = executive ? await settle(() => loadOrganizationReading(session, 'WORK', { now })) : await settle(() => loadPrincipalReading(session, 'WORK', { now, connectionLive: true }));
  if (work.ok && work.value && work.value.projection.state !== 'NONE') out.work = work.value.projection;
  return out;
}

export async function loadFrontDoor(input: {
  readonly session: AuthSession;
  readonly principal: WorkPrincipal;
  readonly groups: readonly NavGroup[];
  readonly time: TimeView;
  /** The viewer's own "needs you" items, loaded once by the page with the session principal. */
  readonly needsYou: readonly NeedsYouItem[];
  /** True only for the executive Home: the organization-wide reads are made for no other seat. */
  readonly executive: boolean;
}): Promise<FrontDoorReads> {
  const { session, principal, groups, time } = input;
  const organizationId = principal.organizationId;

  const [context, chats, intake, creators, readings] = await Promise.all([
    input.executive && navOffers(groups, TILE_PATHS.marketplace)
      ? settle(() => loadCommandContextFor(organizationId, undefined, { session, canAct: async () => false }))
      : Promise.resolve(null),
    navOffers(groups, TILE_PATHS.chats) ? settle(() => loadChatsInput({ session, principal, now: time.now })) : Promise.resolve(null),
    navOffers(groups, TILE_PATHS.intake) ? settle(() => crmRepos.crm.statusCounts(organizationId)) : Promise.resolve(null),
    input.executive && navOffers(groups, TILE_PATHS.creators)
      ? settle(() => absentUntilMigrated(creatorDomain().records.roster(organizationId)))
      : Promise.resolve(null),
    loadTileReadings(session, groups, time.now, input.executive).catch(() => ({})),
  ]);

  const callgrid: Settled<HomeKpiStrip> | null = context === null ? null : context.ok ? kpiStrip(context.value) : { ok: false };
  // The Overview's brief, from the same context. Its own read settles on its own: an engine that
  // cannot run is the tile's honest state, never a missing KPI row.
  const callgridBrief = context?.ok
    ? await settle(async () => {
        const ctx = context.value;
        // Reads only: the engine's reading of the period, never the operational queue that records
        // detections. No priority is named here -- the Overview ranks and records those.
        const reading = await loadExecutiveReading(ctx);
        return executiveBrief(ctx, reading, null);
      })
    : null;

  return { callgrid, callgridBrief, chats, intake, creators, readings };
}

/**
 * The executive row, built by the contract's own rule from the context the Command Center draws --
 * only the choice of figures differs (HOME_KPI_KEYS). Nothing is compared here.
 */
function kpiStrip(ctx: CommandContext): Settled<HomeKpiStrip> {
  const kpis = callGridKpis({
    metrics: ctx.report.metrics,
    comparison: ctx.report.comparison,
    series: ctx.facts?.series ?? [],
    comparisonWithheld: ctx.window !== ctx.selection.window,
    keys: HOME_KPI_KEYS,
  });
  return { ok: true, value: projectHomeKpis({ ...ctx, kpis }) };
}

/**
 * Where a Headline stands, as the Headlines workspace derives it: `headlineSituation` over the
 * Headline and the Case keyed to it. `situation: null` when the Case read failed -- unknown, never
 * "not investigated".
 */
export interface HeadlineStanding {
  readonly situation: HeadlineSituation | null;
  readonly caseId: string | null;
}

/**
 * The standing of every open Headline Home holds: one batched read through the same Case identity
 * the Headlines page resolves, projected by the same pure function. Reading it creates nothing.
 */
export async function loadHeadlineStandings(organizationId: string, headlines: readonly HeadlineView[]): Promise<ReadonlyMap<string, HeadlineStanding>> {
  if (headlines.length === 0) return new Map();
  const headlineIds = headlines.map((h) => h.id);
  const result = await loadCasesForHeadlines(organizationId, headlineIds);
  return new Map(
    headlines.map((h): [string, HeadlineStanding] => {
      if (!result.ok) return [h.id, { situation: null, caseId: null }];
      const kase = result.value.get(h.id) ?? null;
      return [h.id, { situation: headlineSituation(h, kase), caseId: kase?.caseId ?? null }];
    }),
  );
}
