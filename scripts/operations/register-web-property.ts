// Register Web Property -- the operator acts on the authoritative EMG website-property registry (2026-09-30).
//
// WHY IT EXISTS. web_properties is the registry of every EMG website property, live or only owned, each bound to
// ONE organization. Website ingestion admits events only for a registered property that is LIVE with ingestion
// ENABLED; everything else is refused. The migration that creates the table inserts nothing -- a guessed binding
// would route one business's visitors into another's evidence -- so every property is registered here, by a
// person, and every state change is a separate, explicit act.
//
// ACTIONS (one per dispatch):
//   register            one property: key + primary domain (+ allowed domains, label, external bindings, and the
//                       lifecycle a NEW property starts in -- OWNED by default). On an existing property it updates
//                       only label, domains and bindings; never lifecycle, ingestion, primary domain or owner.
//   register-portfolio  every domain in the EMG portfolio list (EMG_WEBSITE_PROPERTIES) for one organization, each
//                       OWNED with ingestion DISABLED. Idempotent; a property already held elsewhere is refused.
//   set-lifecycle       OWNED / BUILDING / LIVE / PAUSED / RETIRED along the governed transitions. Leaving LIVE
//                       disables ingestion; entering LIVE does NOT enable it.
//   enable-ingestion    allow first-party telemetry (LIVE only).
//   disable-ingestion   stop accepting it.
//   commission-live-sites  converge a LIST of this organization's already-registered properties to LIVE with
//                       ingestion ENABLED in one run (--property-keys a,b,c; at most WEB_PROPERTY_COMMISSION_BATCH_MAX
//                       = 25). ALL OR NOTHING: the whole list is validated first -- keys, ownership, the governed
//                       lifecycle transition, ingestion -- and one refusal writes nothing. The writes then run in one
//                       database transaction. A property already LIVE + ENABLED is left as it is, so a re-run
//                       converges. It never registers, reassigns or moves a property.
//
// It contacts no provider, holds no provider credential and connects nothing: the GA4 / Search Console / Bing /
// Clarity fields only record which external property belongs here. DRY RUN FIRST: `--dry-run` resolves,
// validates and reports; it calls no mutating method.
//
// USAGE
//   npm run register:web-property -- --organization <slug> --action register-portfolio [--dry-run]
//   npm run register:web-property -- --organization <slug> --key <key> --primary-domain example.com \
//     [--domain www.example.com] [--label "..."] [--lifecycle OWNED] [--ga4-property-id 123] \
//     [--search-console-site sc-domain:example.com] [--bing-site https://example.com/] [--clarity-project-id x] [--dry-run]
//   npm run register:web-property -- --organization <slug> --key <key> --action set-lifecycle --lifecycle LIVE [--dry-run]
//   npm run register:web-property -- --organization <slug> --key <key> --action enable-ingestion [--dry-run]
//   npm run register:web-property -- --organization <slug> --action commission-live-sites \
//     --property-keys consumersupporthelp,careinmycity [--dry-run]
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL   the DIRECT (non-pooled) endpoint

import {
  WEB_PROPERTY_COMMISSION_BATCH_MAX,
  isWebPropertyLifecycle,
  parseWebPropertyKeyList,
  webPropertyIngestionChange,
  webPropertyLifecycleTransition,
  type WebPropertyIngestion,
  type WebPropertyLifecycle,
} from '@emgloop/shared';
import type { LiveCommissionOutcome, WebPropertyRegistration } from '@emgloop/database';

interface PropertyView {
  key: string;
  organizationId: string;
  lifecycle: string;
  ingestion: string;
}

type StateChange = { outcome: 'CHANGED'; property: PropertyView } | { outcome: 'REFUSED'; code: string };

export interface WebPropertyRegistrar {
  previewRegistration(organizationId: string, r: WebPropertyRegistration): Promise<{ outcome: 'REGISTERED' | 'UPDATED' | 'UNCHANGED' | 'REFUSED'; problems: readonly string[] }>;
  register(organizationId: string, r: WebPropertyRegistration): Promise<{ outcome: 'REGISTERED' | 'UPDATED' | 'UNCHANGED'; property: PropertyView } | { outcome: 'REFUSED'; problems: readonly string[] }>;
  transitionLifecycle(organizationId: string, key: string, to: WebPropertyLifecycle, now: Date): Promise<StateChange>;
  setIngestion(organizationId: string, key: string, to: WebPropertyIngestion): Promise<StateChange>;
  findForOrganization(organizationId: string, key: string): Promise<PropertyView | null>;
  previewLiveCommission(organizationId: string, keys: readonly string[]): Promise<LiveCommissionOutcome>;
  commissionLive(organizationId: string, keys: readonly string[], now: Date): Promise<LiveCommissionOutcome>;
}

/** Read-only organization lookup. This runner never provisions one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; status: string } | null>;
}

export interface RunDeps {
  properties: WebPropertyRegistrar;
  organizations: OrganizationLookup;
  /** The EMG portfolio (register-portfolio): key + domain per owned site. Data, not tenancy. */
  portfolio: readonly { key: string; domain: string; name: string }[];
  now: () => Date;
  log: (line: string) => void;
}

export const RUN_ACTIONS = ['register', 'register-portfolio', 'set-lifecycle', 'enable-ingestion', 'disable-ingestion', 'commission-live-sites'] as const;
export type RunAction = (typeof RUN_ACTIONS)[number];

export interface RunRequest {
  organizationSlug: string;
  action: string;
  key: string;
  /** commission-live-sites: the raw comma-separated key list, parsed strictly by parseWebPropertyKeyList. */
  propertyKeys: string;
  primaryDomain: string;
  lifecycle: string | null;
  label: string | null;
  domains: string[];
  ga4PropertyId: string | null;
  searchConsoleSite: string | null;
  bingSite: string | null;
  clarityProjectId: string | null;
  dryRun: boolean;
}

export type RunOutcome =
  | 'REGISTERED' | 'UPDATED' | 'UNCHANGED' | 'CHANGED' | 'PORTFOLIO_REGISTERED' | 'COMMISSIONED'
  | 'WOULD_REGISTER' | 'WOULD_UPDATE' | 'WOULD_BE_UNCHANGED' | 'WOULD_CHANGE' | 'WOULD_REGISTER_PORTFOLIO' | 'WOULD_COMMISSION'
  | 'REFUSED' | 'FAILED_PRECONDITION';

export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields).map(([k, v]) => `${k}=${v === null ? '-' : String(v)}`).join(' ');
}

const code = (p: string) => (CODE.test(p) ? p : 'UNRECOGNIZED');

export function parseArgs(argv: readonly string[]): RunRequest {
  const r: RunRequest = { organizationSlug: '', action: 'register', key: '', propertyKeys: '', primaryDomain: '', lifecycle: null, label: null, domains: [], ga4PropertyId: null, searchConsoleSite: null, bingSite: null, clarityProjectId: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (argv[i + 1] ?? '').trim();
    const take = () => {
      i++;
      return value;
    };
    if (flag === '--organization' || flag === '--org') r.organizationSlug = take();
    else if (flag === '--action') r.action = take();
    else if (flag === '--key') r.key = take();
    else if (flag === '--property-keys') r.propertyKeys = take();
    else if (flag === '--primary-domain') r.primaryDomain = take().toLowerCase();
    else if (flag === '--lifecycle') r.lifecycle = take() || null;
    else if (flag === '--label') r.label = take() || null;
    else if (flag === '--domain') {
      const d = take();
      if (d) r.domains.push(d.toLowerCase());
    } else if (flag === '--ga4-property-id') r.ga4PropertyId = take() || null;
    else if (flag === '--search-console-site') r.searchConsoleSite = take() || null;
    else if (flag === '--bing-site') r.bingSite = take() || null;
    else if (flag === '--clarity-project-id') r.clarityProjectId = take() || null;
    else if (flag === '--dry-run') r.dryRun = true;
  }
  return r;
}

export async function runRegisterWebProperty(request: RunRequest, deps: RunDeps): Promise<{ outcome: RunOutcome; problems: readonly string[] }> {
  const refuse = (reason: string) => {
    deps.log(line({ event: 'PRECONDITION_FAILED', reason }));
    return { outcome: 'FAILED_PRECONDITION' as const, problems: [reason] };
  };
  const refused = (problems: readonly string[]) => {
    for (const p of problems) deps.log(line({ event: 'REFUSED', code: code(p), written: false }));
    return { outcome: 'REFUSED' as const, problems };
  };
  if (!SLUG.test(request.organizationSlug)) return refuse('--organization must be lowercase letters, digits and hyphens');
  if (!(RUN_ACTIONS as readonly string[]).includes(request.action)) return refuse(`--action must be one of ${RUN_ACTIONS.join(' | ')}`);
  const action = request.action as RunAction;
  if (action !== 'register-portfolio' && action !== 'commission-live-sites' && !request.key) return refuse('--key is required');
  let commissionKeys: string[] = [];
  if (action === 'commission-live-sites') {
    if (request.key) return refuse('commission-live-sites takes --property-keys, not --key');
    const parsed = parseWebPropertyKeyList(request.propertyKeys);
    if (!parsed.ok) {
      for (const r of parsed.refusals) deps.log(line({ event: 'INPUT_REFUSED', position: r.position, key: r.key, code: r.code }));
      return refuse(`--property-keys must be 1-${WEB_PROPERTY_COMMISSION_BATCH_MAX} distinct, well-formed, comma-separated property keys`);
    }
    commissionKeys = parsed.keys;
  }
  if (action === 'set-lifecycle' && !isWebPropertyLifecycle(request.lifecycle)) return refuse('--lifecycle must be OWNED | BUILDING | LIVE | PAUSED | RETIRED');
  if (action === 'register' && request.lifecycle !== null && !isWebPropertyLifecycle(request.lifecycle)) return refuse('--lifecycle must be OWNED | BUILDING | LIVE | PAUSED | RETIRED');

  const org = await deps.organizations.findBySlug(request.organizationSlug);
  if (!org) return refuse('unknown organization');
  if ((REFUSED_ORGANIZATION_STATUSES as readonly string[]).includes(org.status)) return refuse('organization is not active');
  deps.log(line({ event: 'ORGANIZATION', organization: org.slug, action, dryRun: request.dryRun }));

  // --- Commission live sites: preflight the whole list, then all-or-nothing -----------------------------------
  if (action === 'commission-live-sites') {
    const plan = await deps.properties.previewLiveCommission(org.id, commissionKeys);
    if (plan.outcome === 'REFUSED') {
      for (const r of plan.refusals) deps.log(line({ event: 'PREFLIGHT_REFUSED', key: r.key, code: code(r.code) }));
      deps.log(line({ event: 'COMMISSION_REFUSED', requested: commissionKeys.length, refused: plan.refusals.length, written: false }));
      return { outcome: 'REFUSED', problems: plan.refusals.map((r) => `${r.key}:${r.code}`) };
    }
    for (const item of plan.items) deps.log(line({ event: 'COMMISSION_PLAN', key: item.key, lifecycle: item.lifecycle, ingestion: item.ingestion, plan: item.plan }));
    const counts = (items: readonly { plan: string }[]) => ({
      lifecycleAndIngestion: items.filter((i) => i.plan === 'LIFECYCLE_AND_INGESTION').length,
      ingestionOnly: items.filter((i) => i.plan === 'INGESTION_ONLY').length,
      alreadyLive: items.filter((i) => i.plan === 'ALREADY_LIVE').length,
    });
    deps.log(line({ event: 'PRE_WRITE_CHECK', requested: commissionKeys.length, ...counts(plan.items) }));
    if (request.dryRun) {
      deps.log(line({ event: 'DRY_RUN_COMPLETE', written: false, wouldBe: 'WOULD_COMMISSION' }));
      return { outcome: 'WOULD_COMMISSION', problems: [] };
    }
    const result = await deps.properties.commissionLive(org.id, commissionKeys, deps.now());
    if (result.outcome !== 'COMMISSIONED') {
      const refusals = result.outcome === 'REFUSED' ? result.refusals : [];
      for (const r of refusals) deps.log(line({ event: 'COMMISSION_REFUSED_AT_WRITE', key: r.key, code: code(r.code), written: false }));
      return { outcome: 'REFUSED', problems: refusals.map((r) => `${r.key}:${r.code}`) };
    }
    // Read back every property, from the repository rather than the write's own answer.
    let converged = 0;
    let ownerUnchanged = true;
    for (const key of commissionKeys) {
      const stored = await deps.properties.findForOrganization(org.id, key);
      if (stored && stored.lifecycle === 'LIVE' && stored.ingestion === 'ENABLED') converged++;
      if (!stored || stored.organizationId !== org.id) ownerUnchanged = false;
      deps.log(line({ event: 'COMMISSION_READ_BACK', key, lifecycle: stored?.lifecycle ?? null, ingestion: stored?.ingestion ?? null, ownerUnchanged: stored?.organizationId === org.id }));
    }
    deps.log(line({ event: 'COMMISSION_RESULT', written: true, requested: commissionKeys.length, ...counts(result.items), converged, ownerUnchanged }));
    return { outcome: 'COMMISSIONED', problems: converged === commissionKeys.length && ownerUnchanged ? [] : ['READ_BACK_MISMATCH'] };
  }

  // --- State changes: lifecycle and ingestion, each its own act ------------------------------------------
  if (action === 'set-lifecycle' || action === 'enable-ingestion' || action === 'disable-ingestion') {
    const existing = await deps.properties.findForOrganization(org.id, request.key);
    if (!existing) return refused(['PROPERTY_NOT_IN_ORGANIZATION']);
    if (!isWebPropertyLifecycle(existing.lifecycle) || (existing.ingestion !== 'ENABLED' && existing.ingestion !== 'DISABLED')) return refused(['STATE_UNRECOGNIZED']);
    const from = { lifecycle: existing.lifecycle, ingestion: existing.ingestion as WebPropertyIngestion };
    let preview: { ok: true; lifecycle: string; ingestion: string } | { ok: false; code: string };
    if (action === 'set-lifecycle') {
      preview = webPropertyLifecycleTransition(from, request.lifecycle as WebPropertyLifecycle);
    } else {
      const to: WebPropertyIngestion = action === 'enable-ingestion' ? 'ENABLED' : 'DISABLED';
      const allowed = to === from.ingestion ? { ok: false as const, code: 'INGESTION_UNCHANGED' } : webPropertyIngestionChange(from.lifecycle, to);
      preview = allowed.ok ? { ok: true, lifecycle: from.lifecycle, ingestion: to } : allowed;
    }
    deps.log(line({ event: 'PRE_WRITE_CHECK', lifecycle: from.lifecycle, ingestion: from.ingestion, wouldBe: preview.ok ? `${preview.lifecycle}/${preview.ingestion}` : 'REFUSED' }));
    if (!preview.ok) return refused([preview.code]);
    if (request.dryRun) {
      deps.log(line({ event: 'DRY_RUN_COMPLETE', written: false, wouldBe: 'WOULD_CHANGE' }));
      return { outcome: 'WOULD_CHANGE', problems: [] };
    }
    const result = action === 'set-lifecycle'
      ? await deps.properties.transitionLifecycle(org.id, request.key, request.lifecycle as WebPropertyLifecycle, deps.now())
      : await deps.properties.setIngestion(org.id, request.key, action === 'enable-ingestion' ? 'ENABLED' : 'DISABLED');
    if (result.outcome === 'REFUSED') return refused([result.code]);
    const stored = await deps.properties.findForOrganization(org.id, request.key);
    deps.log(line({ event: 'STATE_RESULT', written: true, lifecycle: stored?.lifecycle ?? null, ingestion: stored?.ingestion ?? null, ownerUnchanged: stored?.organizationId === org.id }));
    return { outcome: 'CHANGED', problems: [] };
  }

  // --- Registration: one property, or the whole portfolio ---------------------------------------------------
  const registrations: WebPropertyRegistration[] =
    action === 'register-portfolio'
      ? deps.portfolio.map((p) => ({ key: p.key, primaryDomain: p.domain, label: p.name }))
      : [{
          key: request.key,
          primaryDomain: request.primaryDomain,
          label: request.label,
          ...(request.domains.length > 0 ? { allowedDomains: request.domains } : {}),
          ...(request.lifecycle ? { lifecycle: request.lifecycle as WebPropertyLifecycle } : {}),
          ga4PropertyId: request.ga4PropertyId,
          searchConsoleSiteUrl: request.searchConsoleSite,
          bingSiteUrl: request.bingSite,
          clarityProjectId: request.clarityProjectId,
        }];
  if (registrations.length === 0) return refuse('the portfolio is empty');

  const previews = [];
  for (const r of registrations) previews.push({ r, preview: await deps.properties.previewRegistration(org.id, r) });
  const tally: Record<string, number> = {};
  for (const { preview } of previews) tally[preview.outcome] = (tally[preview.outcome] ?? 0) + 1;
  deps.log(line({ event: 'PRE_WRITE_CHECK', properties: registrations.length, wouldRegister: tally['REGISTERED'] ?? 0, wouldUpdate: tally['UPDATED'] ?? 0, unchanged: tally['UNCHANGED'] ?? 0, refused: tally['REFUSED'] ?? 0 }));
  if (action === 'register') {
    const r = registrations[0]!;
    deps.log(line({ event: 'BINDINGS', ga4Bound: r.ga4PropertyId != null, searchConsoleBound: r.searchConsoleSiteUrl != null, bingBound: r.bingSiteUrl != null, clarityBound: r.clarityProjectId != null }));
  }
  const refusedProblems = previews.flatMap(({ preview }) => (preview.outcome === 'REFUSED' ? preview.problems : []));
  if (refusedProblems.length > 0) return refused([...new Set(refusedProblems)]);

  if (request.dryRun) {
    const would: RunOutcome = action === 'register-portfolio'
      ? 'WOULD_REGISTER_PORTFOLIO'
      : previews[0]!.preview.outcome === 'REGISTERED' ? 'WOULD_REGISTER' : previews[0]!.preview.outcome === 'UPDATED' ? 'WOULD_UPDATE' : 'WOULD_BE_UNCHANGED';
    deps.log(line({ event: 'DRY_RUN_COMPLETE', written: false, wouldBe: would }));
    return { outcome: would, problems: [] };
  }

  const outcomes: Record<string, number> = {};
  for (const r of registrations) {
    const result = await deps.properties.register(org.id, r);
    if (result.outcome === 'REFUSED') return refused(result.problems);
    outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
  }
  // Read back what was written, from the repository rather than the write's own answer.
  let found = 0;
  for (const r of registrations) if (await deps.properties.findForOrganization(org.id, r.key)) found++;
  deps.log(line({ event: 'REGISTRATION_RESULT', registered: outcomes['REGISTERED'] ?? 0, updated: outcomes['UPDATED'] ?? 0, unchanged: outcomes['UNCHANGED'] ?? 0, readBack: found === registrations.length ? 'FOUND' : 'MISSING' }));
  if (action === 'register-portfolio') return { outcome: 'PORTFOLIO_REGISTERED', problems: [] };
  return { outcome: Object.keys(outcomes)[0] as RunOutcome, problems: [] };
}

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');
  if (!process.env.DATABASE_URL?.trim()) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: 'DATABASE_URL' }));
    return 2;
  }
  const { prisma, WebPropertyRepository, EMG_WEBSITE_PROPERTIES } = await import('@emgloop/database');
  try {
    const properties = new WebPropertyRepository(prisma);
    const organizations: OrganizationLookup = {
      findBySlug: (slug) => prisma.organization.findUnique({ where: { slug }, select: { id: true, slug: true, status: true } }),
    };
    const result = await runRegisterWebProperty(parseArgs(process.argv.slice(2)), { properties, organizations, portfolio: EMG_WEBSITE_PROPERTIES, now: () => new Date(), log });
    return result.outcome === 'REFUSED' || result.outcome === 'FAILED_PRECONDITION' || result.problems.length > 0 ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

const ENTRY_POINT = /[\\/]register-web-property\.ts$/;
if (process.argv[1] && ENTRY_POINT.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stdout.write(line({ event: 'RUN_FAILED', reason: 'UNEXPECTED' }) + '\n');
      process.exitCode = 1;
    },
  );
}
