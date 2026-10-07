// The governed operator path for the CRM import's reviewed mappings (CRM slice 5): creator aliases
// and route classifications, recorded from a reviewed configuration artifact. OWNER / ADMIN only
// (MAP_CREATOR_ALIAS, MAP_ROUTE). No app UI in this slice.
//
// THE ARTIFACT IS NOT THE AUTHORITY: these tables are. A reviewed file is checked whole -- shape,
// collisions, and every Party it names through the Party Reference contract -- and then recorded in
// ONE transaction, or nothing is. Mappings already recorded identically are left alone; a changed
// mapping is refused unless the operator asked to replace, and replacing is append-only (the old
// row is retired, never edited). A mapping absent from the file is left as it is.
//
// The Parties are checked, never guessed: a creator must be an established, current PERSON; a target
// or represented brand an established, current COMPANY. A superseded id is refused with its
// canonical id, never swapped. Audit rows carry ids and codes only.

import type { PrismaClient } from '@prisma/client';
import {
  crmImportKey,
  partyReferenceForWrite,
  validateCrmImportConfig,
  type CrmImportConfig,
  type CrmImportConfigViolation,
  type CrmImportRouteConfig,
  type PartyReferenceResolution,
} from '@emgloop/shared';

import { AuditRepository } from '../repositories/audit.repository';
import { IamRepository } from '../repositories/iam.repository';
import { PartyReferenceRepository } from '../repositories/party-reference.repository';
import { crmImportPermits, type CrmImportActor } from './crm-import-access';
import { CrmImportConcurrentChange, CrmImportRepository, isUniqueViolation, type CrmImportAliasRow, type CrmImportRouteRow } from './crm-import.repository';

export type CrmImportMappingOutcome = 'RECORDED' | 'REPLACED' | 'UNCHANGED' | 'CHANGE_REQUIRES_REPLACE' | 'PARTY_REFUSED';

export interface CrmImportMappingResult {
  readonly kind: 'CREATOR_ALIAS' | 'ROUTE';
  readonly key: string;
  readonly outcome: CrmImportMappingOutcome;
  readonly reason: string | null;
  readonly mappingId: string | null;
}

export type CrmImportConfigResult =
  | { readonly outcome: 'RECORDED'; readonly items: readonly CrmImportMappingResult[] }
  | { readonly outcome: 'REFUSED'; readonly items: readonly CrmImportMappingResult[] }
  | { readonly outcome: 'INVALID'; readonly violations: readonly CrmImportConfigViolation[] }
  | { readonly outcome: 'NOT_AUTHORIZED' }
  | { readonly outcome: 'RETRY' };

export interface CrmImportConfigServiceDeps {
  imports?: CrmImportRepository;
  references?: Pick<PartyReferenceRepository, 'resolveMany'>;
  audit?: Pick<AuditRepository, 'record'>;
  iam?: Pick<IamRepository, 'canEach'>;
}

export class CrmImportConfigService {
  private readonly imports: CrmImportRepository;
  private readonly references: Pick<PartyReferenceRepository, 'resolveMany'>;
  private readonly audit: Pick<AuditRepository, 'record'>;
  private readonly iam: Pick<IamRepository, 'canEach'>;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmImportConfigServiceDeps = {},
  ) {
    this.imports = deps.imports ?? new CrmImportRepository(prisma);
    this.references = deps.references ?? new PartyReferenceRepository(prisma);
    this.audit = deps.audit ?? new AuditRepository(prisma);
    this.iam = deps.iam ?? new IamRepository(prisma);
  }

  /** Record a reviewed configuration's aliases and routes. All or nothing. */
  async record(actor: CrmImportActor, config: unknown, options: { readonly replace?: boolean } = {}): Promise<CrmImportConfigResult> {
    const [mayAlias, mayRoute] = await Promise.all([
      crmImportPermits(this.prisma, this.iam, actor, 'MAP_CREATOR_ALIAS'),
      crmImportPermits(this.prisma, this.iam, actor, 'MAP_ROUTE'),
    ]);
    if (!mayAlias || !mayRoute) return { outcome: 'NOT_AUTHORIZED' };
    const checked = validateCrmImportConfig(config);
    if (!checked.ok) return { outcome: 'INVALID', violations: checked.violations };
    const cfg: CrmImportConfig = checked.config;
    const org = actor.organizationId;

    // Every Party the file names, through the one Party Reference authority.
    const partyIds = [
      ...cfg.creatorAliases.map((a) => a.creatorPartyId.trim()),
      ...cfg.routes.flatMap((r) => [r.targetCompanyPartyId?.trim(), r.representedBrandPartyId?.trim()].filter((id): id is string => Boolean(id))),
    ];
    const resolutions = await this.references.resolveMany(org, partyIds);
    const [aliases, routes] = await Promise.all([this.imports.activeAliases(org), this.imports.activeRoutes(org)]);
    const activeAlias = new Map(aliases.map((a) => [a.aliasKey, a]));
    const activeRoute = new Map(routes.map((r) => [r.routeKey, r]));

    const items: CrmImportMappingResult[] = [];
    const aliasWrites: { key: string; text: string; creatorPartyId: string; replacing: CrmImportAliasRow | null }[] = [];
    const routeWrites: { fields: Omit<CrmImportRouteRow, 'id'>; replacing: CrmImportRouteRow | null }[] = [];

    for (const a of cfg.creatorAliases) {
      const key = crmImportKey(a.alias);
      const refusal = refuseParty(resolutions.get(a.creatorPartyId.trim()), 'PERSON');
      if (refusal) {
        items.push({ kind: 'CREATOR_ALIAS', key, outcome: 'PARTY_REFUSED', reason: refusal, mappingId: null });
        continue;
      }
      const current = activeAlias.get(key) ?? null;
      if (current && current.creatorPartyId === a.creatorPartyId.trim()) {
        items.push({ kind: 'CREATOR_ALIAS', key, outcome: 'UNCHANGED', reason: null, mappingId: current.id });
        continue;
      }
      if (current && !options.replace) {
        items.push({ kind: 'CREATOR_ALIAS', key, outcome: 'CHANGE_REQUIRES_REPLACE', reason: null, mappingId: current.id });
        continue;
      }
      aliasWrites.push({ key, text: a.alias.trim(), creatorPartyId: a.creatorPartyId.trim(), replacing: current });
    }

    for (const r of cfg.routes) {
      const fields = routeFields(r);
      const refusal =
        (fields.targetCompanyPartyId ? refuseParty(resolutions.get(fields.targetCompanyPartyId), 'COMPANY') : null) ??
        (fields.representedBrandPartyId ? refuseParty(resolutions.get(fields.representedBrandPartyId), 'COMPANY') : null);
      if (refusal) {
        items.push({ kind: 'ROUTE', key: fields.routeKey, outcome: 'PARTY_REFUSED', reason: refusal, mappingId: null });
        continue;
      }
      const current = activeRoute.get(fields.routeKey) ?? null;
      if (current && sameRoute(current, fields)) {
        items.push({ kind: 'ROUTE', key: fields.routeKey, outcome: 'UNCHANGED', reason: null, mappingId: current.id });
        continue;
      }
      if (current && !options.replace) {
        items.push({ kind: 'ROUTE', key: fields.routeKey, outcome: 'CHANGE_REQUIRES_REPLACE', reason: null, mappingId: current.id });
        continue;
      }
      routeWrites.push({ fields, replacing: current });
    }

    if (items.some((i) => i.outcome === 'PARTY_REFUSED' || i.outcome === 'CHANGE_REQUIRES_REPLACE')) return { outcome: 'REFUSED', items };

    const actorName = await this.actorName(actor);
    try {
      const written = await this.prisma.$transaction(async (tx) => {
        const out: CrmImportMappingResult[] = [];
        for (const w of aliasWrites) {
          const row = await this.imports.recordAlias(org, { aliasKey: w.key, aliasText: w.text, creatorPartyId: w.creatorPartyId, actorUserId: actor.userId, replacingId: w.replacing?.id ?? null }, tx);
          await this.audit.record(
            { organizationId: org, userId: actor.userId, actorName, action: 'crm_import.creator_alias_recorded', entityType: 'crm_import_creator_alias', entityId: row.id, metadata: { creatorPartyId: row.creatorPartyId, replacedMappingId: w.replacing?.id ?? null } },
            tx,
          );
          out.push({ kind: 'CREATOR_ALIAS', key: w.key, outcome: w.replacing ? 'REPLACED' : 'RECORDED', reason: null, mappingId: row.id });
        }
        for (const w of routeWrites) {
          const row = await this.imports.recordRoute(org, { ...w.fields, actorUserId: actor.userId, replacingId: w.replacing?.id ?? null }, tx);
          await this.audit.record(
            {
              organizationId: org,
              userId: actor.userId,
              actorName,
              action: 'crm_import.route_mapping_recorded',
              entityType: 'crm_import_route_mapping',
              entityId: row.id,
              metadata: {
                classification: row.classification,
                targetCompanyPartyId: row.targetCompanyPartyId,
                representedBrandPartyId: row.representedBrandPartyId,
                proposesCompany: row.proposedCompanyName !== null,
                representsRoute: row.representedBrandRouteKey !== null,
                replacedMappingId: w.replacing?.id ?? null,
              },
            },
            tx,
          );
          out.push({ kind: 'ROUTE', key: w.fields.routeKey, outcome: w.replacing ? 'REPLACED' : 'RECORDED', reason: null, mappingId: row.id });
        }
        return out;
      });
      return { outcome: 'RECORDED', items: [...items, ...written] };
    } catch (err) {
      // Another operator recorded or replaced a mapping between the read and the write.
      if (err instanceof CrmImportConcurrentChange || isUniqueViolation(err)) return { outcome: 'RETRY' };
      throw err;
    }
  }

  private async actorName(actor: CrmImportActor): Promise<string | undefined> {
    const member = await this.prisma.user.findFirst({ where: { id: actor.userId, organizationId: actor.organizationId }, select: { name: true } });
    return member?.name?.trim() || undefined;
  }
}

function routeFields(r: CrmImportRouteConfig): Omit<CrmImportRouteRow, 'id'> {
  return {
    routeKey: crmImportKey(r.routeKey),
    routeText: r.routeKey.trim(),
    classification: r.classification,
    targetCompanyPartyId: r.targetCompanyPartyId?.trim() || null,
    proposedCompanyName: r.proposedCompanyName?.trim() || null,
    representedBrandPartyId: r.representedBrandPartyId?.trim() || null,
    representedBrandRouteKey: crmImportKey(r.representedBrandRouteKey) || null,
  };
}

function sameRoute(a: Omit<CrmImportRouteRow, 'id'>, b: Omit<CrmImportRouteRow, 'id'>): boolean {
  return (
    a.classification === b.classification &&
    a.targetCompanyPartyId === b.targetCompanyPartyId &&
    a.proposedCompanyName === b.proposedCompanyName &&
    a.representedBrandPartyId === b.representedBrandPartyId &&
    a.representedBrandRouteKey === b.representedBrandRouteKey
  );
}

/** Null when the reference may be written: established, current, not archived, of this type. */
function refuseParty(resolution: PartyReferenceResolution | undefined, type: 'PERSON' | 'COMPANY'): string | null {
  if (!resolution) return 'NOT_FOUND';
  const write = partyReferenceForWrite(resolution);
  if (!write.ok) return write.refusal;
  if (resolution.state !== 'ESTABLISHED' || resolution.partyType !== type) return 'WRONG_PARTY_TYPE';
  return null;
}
