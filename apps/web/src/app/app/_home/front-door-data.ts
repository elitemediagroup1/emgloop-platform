// The front door's additive reads, for one signed-in person. SERVER ONLY.
//
// Loop Home COMPOSES existing authorities and never becomes one. Every read below is a read some
// page of Loop already makes, through the same repository or service, under the same organization:
// the Command Center's context (admin/marketplace/command-data.ts), the person's own Telegram
// connection as the Connections page reads it, the CRM repository's intake counts, the creator
// roster the Creators page draws, and the investigation behind a Headline. Nothing here writes.
//
// GATED BY THE NAVIGATION THIS PERSON WAS OFFERED. A domain is read only when its destination is in
// the resolved nav groups (permissions and role authority, fail closed) -- and the pages behind
// those destinations still enforce their own authority on arrival. The executive reads (CallGrid,
// creators) are made only for the executive Home, whatever the groups say.
//
// THE ORGANIZATION AND THE PERSON COME FROM THE SIGNED SESSION, and every read settles on its own: a
// domain that cannot be read becomes its tile's honest state, never a Home that fails to render.

import 'server-only';

import { absentUntilMigrated, type WorkPrincipal } from '@emgloop/database';
import type { TimeView } from '@emgloop/shared';

import type { AuthSession } from '../../../auth/auth';
import { sourceConnections } from '../../../connections/source-connection-runtime';
import { creatorDomain } from '../../../creator/creator-runtime';
import { crmRepos } from '../../../crm/crm-data';
import type { NavGroup } from '../../../workspaces/config';
import { connectionPresentation } from '../_connections/source-connections-panel';
import { loadCasesForHeadlines } from '../admin/headlines/headlines-data';
import { callGridKpis } from '@emgloop/shared';
import { SourceObservationRepository, prisma } from '@emgloop/database';
import { loadCommandContextFor } from '../admin/marketplace/command-data';
import { HOME_KPI_KEYS, projectHomeKpis, type HomeKpiStrip } from './kpis';
import { settle, type Settled } from './settle';
import { TILE_PATHS, type RosterRowInput, type TelegramTileInput } from './tiles';

/** Whether the rail this person was offered leads to `href`. Nav visibility, not authorization. */
export function navOffers(groups: readonly NavGroup[], href: string): boolean {
  return groups.some((g) => g.items.some((i) => !i.soon && i.href === href));
}

export interface FrontDoorReads {
  /** The Command Center's context, projected; null when CallGrid is not offered to this person. */
  readonly callgrid: Settled<HomeKpiStrip> | null;
  /** The viewer's own Telegram connection, in the Connections page's words; null when not offered. */
  readonly telegram: Settled<TelegramTileInput | null> | null;
  /** Intake records per status; null when the Intake Board is not offered. */
  readonly intake: Settled<Readonly<Record<string, number>>> | null;
  /** The creator roster; `value: null` while its migration has not reached this database; null when not offered. */
  readonly creators: Settled<readonly RosterRowInput[] | null> | null;
}

export async function loadFrontDoor(input: {
  readonly session: AuthSession;
  readonly principal: WorkPrincipal;
  readonly groups: readonly NavGroup[];
  readonly time: TimeView;
  /** True only for the executive Home: the organization-wide reads are made for no other seat. */
  readonly executive: boolean;
}): Promise<FrontDoorReads> {
  const { session, principal, groups, time } = input;
  const organizationId = principal.organizationId;

  const [callgrid, telegram, intake, creators] = await Promise.all([
    input.executive && navOffers(groups, TILE_PATHS.marketplace)
      ? settle(async () => {
          const ctx = await loadCommandContextFor(organizationId, undefined, { session, canAct: async () => false });
          // The executive row is built by the contract's own rule from the same context the Command Center
          // draws -- only the choice of figures differs (HOME_KPI_KEYS). Nothing is compared here.
          const kpis = callGridKpis({
            metrics: ctx.report.metrics,
            comparison: ctx.report.comparison,
            series: ctx.facts?.series ?? [],
            comparisonWithheld: ctx.window !== ctx.selection.window,
            keys: HOME_KPI_KEYS,
          });
          return projectHomeKpis({ ...ctx, kpis });
        })
      : Promise.resolve(null),
    navOffers(groups, TILE_PATHS.connections)
      ? settle(async (): Promise<TelegramTileInput | null> => {
          const status = await sourceConnections().status({ organizationId, userId: principal.userId, name: session.name });
          if (!status.permitted) return null;
          const view = status.providers.find((p) => p.profile.provider === 'TELEGRAM');
          if (!view) return null;
          const words = connectionPresentation(view, time);
          // The viewer's OWN activity, as content-free counts from the governed observation store, for the
          // last day. A failed count is null -- said on the tile, never drawn as a zero.
          const since = new Date(time.now.getTime() - 24 * 60 * 60 * 1000);
          const activity = await new SourceObservationRepository(prisma)
            .activitySince(organizationId, principal.userId, 'TELEGRAM', since)
            .then((a) => ({ since, ...a }))
            .catch(() => null);
          return {
            permitted: true,
            configured: view.configured,
            state: view.state,
            words: { label: words.pill.label, tone: words.pill.tone, detail: words.detail },
            lastObservedAt: view.lastObservedAt,
            contentAuthorized: view.contentAuthorized,
            activity,
          };
        })
      : Promise.resolve(null),
    navOffers(groups, TILE_PATHS.intake) ? settle(() => crmRepos.crm.statusCounts(organizationId)) : Promise.resolve(null),
    input.executive && navOffers(groups, TILE_PATHS.creators)
      ? settle(() => absentUntilMigrated(creatorDomain().records.roster(organizationId)))
      : Promise.resolve(null),
  ]);

  return { callgrid, telegram, intake, creators };
}

/** Whether a Headline is under investigation: a Case keyed to it exists. UNKNOWN when that read failed. */
export type HeadlineCaseState = { readonly state: 'UNDER_INVESTIGATION'; readonly caseId: string } | { readonly state: 'NEW' } | { readonly state: 'UNKNOWN' };

/**
 * The investigation state of each Headline Home shows: one batched read through the same Case
 * identity the Headlines page resolves. A Headline absent from the map opened no Case. Reading it
 * creates nothing; a failed read is UNKNOWN for every Headline, never "not investigated".
 */
export async function loadHeadlineCases(organizationId: string, headlineIds: readonly string[]): Promise<ReadonlyMap<string, HeadlineCaseState>> {
  if (headlineIds.length === 0) return new Map();
  const result = await loadCasesForHeadlines(organizationId, headlineIds);
  return new Map(
    headlineIds.map((id): [string, HeadlineCaseState] => {
      if (!result.ok) return [id, { state: 'UNKNOWN' }];
      const kase = result.value.get(id);
      return [id, kase ? { state: 'UNDER_INVESTIGATION', caseId: kase.caseId } : { state: 'NEW' }];
    }),
  );
}
