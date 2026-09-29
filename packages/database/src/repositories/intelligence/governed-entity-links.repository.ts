// Governed entity-link projection -- what Loop's own governed records ALREADY prove connects two canonical
// entities, projected at read time for Situation clustering. Loop Intelligence, 2026-09-29.
//
// A PROJECTION, NOT A STORE. Nothing here is written: each read derives the links from the records that state
// them, so a link can never outlive its record (a reversed Party link simply stops projecting) and nothing
// needs backfilling or cleaning. Persisted `entity_links` (explicit declarations) are read beside these by the
// Situation pass; a model never authors either.
//
// ONLY WHAT A GOVERNED RECORD PROVES. Three relationship classes, each from one record, each deterministic:
//
//   CUSTOMER_PARTY  customer:<id> <-> party:<id>   an ACTIVE CustomerPartyLink (the human-approved, reversible
//                                                  link an Intake Record has to its Party), to a Party that is
//                                                  established and neither archived nor superseded.
//   CREATOR_PARTY   creator:<id>  <-> party:<id>   CreatorProfile.partyId, to such a Party.
//   WORK_ORIGIN     work_instance:<id> <-> <ref>   a WorkOrigin a person confirmed (Promote to Work) from an
//                                                  ORGANIZATION digest signal naming exactly ONE canonical entity,
//                                                  to that entity -- while that digest and signal still exist.
//
// A LINK IS A BRIDGE, NEVER EVIDENCE. A projected link only says two references are the same thing (or one is
// about the other); it carries no source. A promoted Work item therefore adds no independence by existing: a
// cluster gains the LOOP_WORK source only when the Work READING names the instance, which it does only for
// Work's own state (a step past due, work past its committed return) -- see work.domain.
//
// ONE ENTITY PER ORIGIN. A signal that names several entities is about a set ("3 records stalled in Quoted", "5
// productions waiting on EMG"), not a relationship among its members. Linking the work to all of them would join
// every member to every other, permanently and for any signal -- so such an origin is rejected
// (SIGNAL_NAMES_SEVERAL), never fanned out.
//
// CHAINS. For a pass, the projection starts from the references its signals name and follows what it reaches, a
// bounded number of hops (GOVERNED_LINK_HOPS): work -> the customer it came from -> that customer's Party <- a
// creator on it. A Party is only ever reached, never expanded: nothing here asks "every record on this Party", so
// a broad Party joins only entities the signals already name or that a governed record reaches from them.
//
// NOT PROJECTED, BY DESIGN (see docs/architecture/loop-intelligence.md, "Governed entity links"): a CallGrid
// caller to an Intake Record (no governed record proves it; a phone, name, email, label, time or campaign
// coincidence is not identity); a Case origin (its evidence names provider members by the detector's own keys,
// not through a canonical reference); a private (PRINCIPAL) Work origin (never into organization intelligence);
// CRM campaigns and opportunities (no domain reading names them as entities today). Organization scope only:
// a PRINCIPAL situation pass projects nothing.
//
// FAIL CLOSED, ONE ORGANIZATION. Every read is scoped by the organization; a record that does not resolve inside
// it (a Party in another organization, a missing Party, a Work instance that is not the organization's) is
// rejected with a reason code, never guessed. What leaves: canonical references for the pass, and counts and
// codes for diagnostics. Construct with the Prisma client, or `readOnlyClient(prisma)` for diagnostics.

import type { PrismaClient } from '@prisma/client';
import { entityRefRefusal } from '@emgloop/shared';

export const GOVERNED_LINK_CLASSES = ['CUSTOMER_PARTY', 'CREATOR_PARTY', 'WORK_ORIGIN'] as const;
export type GovernedLinkClass = (typeof GOVERNED_LINK_CLASSES)[number];

/** Why a governed record did not project a link. Codes only. */
export type GovernedLinkRejection =
  | 'PARTY_NOT_ESTABLISHED'
  | 'NO_PARTY'
  | 'NOT_A_REFERENCE'
  | 'WORK_NOT_IN_ORGANIZATION'
  | 'PRIVATE_SCOPE'
  | 'CASE_ORIGIN_NOT_CANONICAL'
  | 'WORK_ITEM_ORIGIN'
  | 'DIGEST_GONE'
  | 'SIGNAL_GONE'
  | 'SIGNAL_NAMES_NO_ENTITY'
  | 'SIGNAL_NAMES_SEVERAL'
  | 'CUSTOMER_NOT_IN_ORGANIZATION'
  | 'OTHER_ORIGIN';

export interface ProjectedLink {
  readonly fromRef: string;
  readonly toRef: string;
  readonly linkClass: GovernedLinkClass;
}

export interface GovernedLinkClassCount {
  readonly linkClass: GovernedLinkClass;
  /** Governed records of this class examined. */
  readonly records: number;
  /** Links they project. */
  readonly links: number;
  readonly rejected: Readonly<Partial<Record<GovernedLinkRejection, number>>>;
}

export interface GovernedProjection {
  readonly links: readonly ProjectedLink[];
  readonly classes: readonly GovernedLinkClassCount[];
  /** A read stopped at its bound: the counts are a lower bound. */
  readonly bounded: boolean;
}

/** Records one projection may read per class before it stops and says so. */
export const GOVERNED_LINK_BOUND = 5_000;
const CHUNK = 1_000;
/** How far a pass's projection follows what it reaches: work -> origin entity -> its Party covers every chain. */
export const GOVERNED_LINK_HOPS = 3;
/** Reference kinds a governed record projects FROM (a Party is only ever a target). */
const EXPANDABLE = ['customer:', 'creator:', 'work_instance:'];
const ESTABLISHED = { establishedAt: { not: null }, supersededAt: null, archivedAt: null } as const;
const ref = (kind: string, id: string) => `${kind}:${id}`;
const isRef = (r: string) => entityRefRefusal(r, 'ORGANIZATION') === null;
const idsOf = (refs: readonly string[] | null, kind: string) => (refs === null ? null : [...new Set(refs.filter((r) => r.startsWith(`${kind}:`)).map((r) => r.slice(kind.length + 1)))]);

export class GovernedEntityLinkProjector {
  constructor(private readonly db: PrismaClient) {}

  private async establishedParties(organizationId: string, ids: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += CHUNK) {
      const rows = await this.db.cognitiveIdentity.findMany({ where: { organizationId, id: { in: unique.slice(i, i + CHUNK) }, ...ESTABLISHED }, select: { id: true } });
      for (const r of rows) out.add(r.id);
    }
    return out;
  }

  /**
   * The links the governed records project for these references (the ones in play in a pass), or -- with
   * `refs` null -- for every governed record of the organization (diagnostics). Deterministic: the same
   * records always project the same links.
   */
  async project(organizationId: string, refs: readonly string[] | null): Promise<GovernedProjection> {
    if (refs === null || !organizationId) return this.projectOnce(organizationId, refs);
    // A pass: from the references in play, then from what they reach -- each record read once, bounded.
    const seen = new Set(refs);
    const links: ProjectedLink[] = [];
    const linkKeys = new Set<string>();
    const totals = new Map<GovernedLinkClass, { records: number; links: number; rejected: Partial<Record<GovernedLinkRejection, number>> }>();
    let bounded = false;
    let frontier: readonly string[] = refs;
    for (let hop = 0; frontier.length > 0; hop += 1) {
      if (hop === GOVERNED_LINK_HOPS) {
        bounded = true;
        break;
      }
      const round = await this.projectOnce(organizationId, frontier);
      bounded ||= round.bounded;
      for (const c of round.classes) {
        const t = totals.get(c.linkClass) ?? { records: 0, links: 0, rejected: {} };
        t.records += c.records;
        t.links += c.links;
        for (const [code, n] of Object.entries(c.rejected)) t.rejected[code as GovernedLinkRejection] = (t.rejected[code as GovernedLinkRejection] ?? 0) + (n ?? 0);
        totals.set(c.linkClass, t);
      }
      const next: string[] = [];
      for (const l of round.links) {
        const k = `${l.fromRef}|${l.toRef}`;
        if (!linkKeys.has(k)) (linkKeys.add(k), links.push(l));
        for (const r of [l.fromRef, l.toRef]) if (!seen.has(r) && EXPANDABLE.some((p) => r.startsWith(p))) (seen.add(r), next.push(r));
      }
      frontier = next;
    }
    return { links, classes: GOVERNED_LINK_CLASSES.map((linkClass) => ({ linkClass, ...(totals.get(linkClass) ?? { records: 0, links: 0, rejected: {} }) })), bounded };
  }

  private async projectOnce(organizationId: string, refs: readonly string[] | null): Promise<GovernedProjection> {
    if (!organizationId) return { links: [], classes: GOVERNED_LINK_CLASSES.map((linkClass) => ({ linkClass, records: 0, links: 0, rejected: {} })), bounded: false };
    const org = { organizationId };
    const links: ProjectedLink[] = [];
    const classes: GovernedLinkClassCount[] = [];
    let bounded = false;
    const take = GOVERNED_LINK_BOUND + 1;
    const reject = (r: Partial<Record<GovernedLinkRejection, number>>, code: GovernedLinkRejection) => void (r[code] = (r[code] ?? 0) + 1);

    // CUSTOMER_PARTY: active links only, to an established Party of this organization.
    {
      const customerIds = idsOf(refs, 'customer');
      const rows = customerIds !== null && customerIds.length === 0
        ? []
        : await this.db.customerPartyLink.findMany({ where: { ...org, reversedAt: null, activeCustomerId: { not: null }, ...(customerIds ? { customerId: { in: customerIds } } : {}) }, select: { customerId: true, partyId: true }, take });
      if (rows.length > GOVERNED_LINK_BOUND) bounded = true;
      const kept = rows.slice(0, GOVERNED_LINK_BOUND);
      const parties = await this.establishedParties(organizationId, kept.map((r) => r.partyId));
      // The link row is the organization's, but nothing in the schema ties its customer to the same organization.
      const customers = new Set<string>();
      const wantedCustomers = [...new Set(kept.map((r) => r.customerId))];
      for (let i = 0; i < wantedCustomers.length; i += CHUNK) {
        for (const c of await this.db.customer.findMany({ where: { ...org, id: { in: wantedCustomers.slice(i, i + CHUNK) } }, select: { id: true } })) customers.add(c.id);
      }
      const rejected: Partial<Record<GovernedLinkRejection, number>> = {};
      let n = 0;
      for (const r of kept) {
        const [a, b] = [ref('customer', r.customerId), ref('party', r.partyId)];
        if (!customers.has(r.customerId)) reject(rejected, 'CUSTOMER_NOT_IN_ORGANIZATION');
        else if (!parties.has(r.partyId)) reject(rejected, 'PARTY_NOT_ESTABLISHED');
        else if (!isRef(a) || !isRef(b)) reject(rejected, 'NOT_A_REFERENCE');
        else {
          links.push({ fromRef: a, toRef: b, linkClass: 'CUSTOMER_PARTY' });
          n += 1;
        }
      }
      classes.push({ linkClass: 'CUSTOMER_PARTY', records: kept.length, links: n, rejected });
    }

    // CREATOR_PARTY: the profile's governed Party, established, in this organization.
    {
      const creatorIds = idsOf(refs, 'creator');
      let rows: { id: string; partyId: string | null }[] = [];
      if (!(creatorIds !== null && creatorIds.length === 0)) {
        try {
          rows = await this.db.creatorProfile.findMany({ where: { ...org, ...(creatorIds ? { id: { in: creatorIds } } : {}) }, select: { id: true, partyId: true }, take });
        } catch (err) {
          // The Creator Hub migration may not have reached this database: no profiles, nothing to project.
          if (!(err && typeof err === 'object' && ['P2021', 'P2022'].includes(String((err as { code?: unknown }).code)))) throw err;
        }
      }
      if (rows.length > GOVERNED_LINK_BOUND) bounded = true;
      const kept = rows.slice(0, GOVERNED_LINK_BOUND);
      const parties = await this.establishedParties(organizationId, kept.flatMap((r) => (r.partyId ? [r.partyId] : [])));
      const rejected: Partial<Record<GovernedLinkRejection, number>> = {};
      let n = 0;
      for (const r of kept) {
        if (!r.partyId) {
          reject(rejected, 'NO_PARTY');
          continue;
        }
        const [a, b] = [ref('creator', r.id), ref('party', r.partyId)];
        if (!parties.has(r.partyId)) reject(rejected, 'PARTY_NOT_ESTABLISHED');
        else if (!isRef(a) || !isRef(b)) reject(rejected, 'NOT_A_REFERENCE');
        else {
          links.push({ fromRef: a, toRef: b, linkClass: 'CREATOR_PARTY' });
          n += 1;
        }
      }
      classes.push({ linkClass: 'CREATOR_PARTY', records: kept.length, links: n, rejected });
    }

    // WORK_ORIGIN: a person's promotion from an ORGANIZATION digest signal, to the entities that signal names.
    {
      const workIds = idsOf(refs, 'work_instance');
      const rows = workIds !== null && workIds.length === 0
        ? []
        : await this.db.workOrigin.findMany({ where: { ...org, ...(workIds ? { workInstanceId: { in: workIds } } : {}) }, select: { workInstanceId: true, originKind: true, originScope: true, originRef: true }, take });
      if (rows.length > GOVERNED_LINK_BOUND) bounded = true;
      const kept = rows.slice(0, GOVERNED_LINK_BOUND);
      const instances = new Set<string>();
      const wanted = [...new Set(kept.map((r) => r.workInstanceId))];
      for (let i = 0; i < wanted.length; i += CHUNK) {
        for (const w of await this.db.workInstance.findMany({ where: { ...org, id: { in: wanted.slice(i, i + CHUNK) } }, select: { id: true } })) instances.add(w.id);
      }
      const digestIds = [...new Set(kept.filter((r) => r.originKind === 'DIGEST_SIGNAL' && r.originScope === 'ORGANIZATION').map((r) => r.originRef.split('#')[0]!).filter(Boolean))];
      const signalsOf = new Map<string, { key?: unknown; entities?: unknown }[]>();
      for (let i = 0; i < digestIds.length; i += CHUNK) {
        const digests = await this.db.intelligenceDigest.findMany({ where: { ...org, scope: 'ORGANIZATION', userId: null, id: { in: digestIds.slice(i, i + CHUNK) } }, select: { id: true, content: true } });
        for (const d of digests) signalsOf.set(d.id, ((d.content as { signals?: { key?: unknown; entities?: unknown }[] } | null)?.signals ?? []));
      }
      const rejected: Partial<Record<GovernedLinkRejection, number>> = {};
      let n = 0;
      for (const r of kept) {
        if (!instances.has(r.workInstanceId)) reject(rejected, 'WORK_NOT_IN_ORGANIZATION');
        else if (r.originScope !== 'ORGANIZATION') reject(rejected, 'PRIVATE_SCOPE');
        else if (r.originKind === 'CASE') reject(rejected, 'CASE_ORIGIN_NOT_CANONICAL');
        else if (r.originKind === 'WORK_ITEM') reject(rejected, 'WORK_ITEM_ORIGIN');
        else if (r.originKind !== 'DIGEST_SIGNAL') reject(rejected, 'OTHER_ORIGIN');
        else {
          const at = r.originRef.indexOf('#');
          const signals = at > 0 ? signalsOf.get(r.originRef.slice(0, at)) : undefined;
          const signal = signals?.find((s) => s.key === r.originRef.slice(at + 1));
          const entities = Array.isArray(signal?.entities) ? [...new Set((signal!.entities as unknown[]).filter((e): e is string => typeof e === 'string' && isRef(e)))] : [];
          const from = ref('work_instance', r.workInstanceId);
          if (!signals) reject(rejected, 'DIGEST_GONE');
          else if (!signal) reject(rejected, 'SIGNAL_GONE');
          else if (entities.length === 0) reject(rejected, 'SIGNAL_NAMES_NO_ENTITY');
          else if (entities.length > 1) reject(rejected, 'SIGNAL_NAMES_SEVERAL');
          else if (!isRef(from)) reject(rejected, 'NOT_A_REFERENCE');
          else {
            links.push({ fromRef: from, toRef: entities[0]!, linkClass: 'WORK_ORIGIN' });
            n += 1;
          }
        }
      }
      classes.push({ linkClass: 'WORK_ORIGIN', records: kept.length, links: n, rejected });
    }

    return { links, classes, bounded };
  }
}
