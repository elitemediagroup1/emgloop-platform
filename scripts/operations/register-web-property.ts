// Register a website property -- the operator act that binds a property to ONE organization (2026-09-30).
//
// WHY IT EXISTS. Website ingestion resolves tenancy only through web_properties: an event whose property no one
// registered is refused (PROPERTY_UNREGISTERED). The migration that creates the table inserts nothing -- a guessed
// binding would route one business's visitors into another's evidence -- so every real property is registered
// here, deliberately, by a person, one at a time. The number of properties is whatever gets registered.
//
// WHAT IT WRITES. One web_properties row, through WebPropertyRepository: register (create, or update the
// bindings of this organization's own property), or enable / disable it. A key already registered to ANOTHER
// organization is refused, never moved. It contacts no provider, holds no provider credential, and connects no
// GA4 property, Search Console site, Bing site or Clarity project: the binding fields record WHICH external
// property belongs here, for a connector that does not exist yet.
//
// DRY RUN FIRST. `--dry-run` resolves the organization, validates, and reports what would happen; it does not
// call a mutating method.
//
// USAGE
//
//   npm run register:web-property -- --organization <slug> --key <property-key> \
//     --domain example.com [--domain www.example.com] [--label "..."] \
//     [--ga4-property-id 123456789] [--search-console-site sc-domain:example.com] \
//     [--bing-site https://example.com/] [--clarity-project-id abcdef1234] [--dry-run]
//   npm run register:web-property -- --organization <slug> --key <property-key> --action disable [--dry-run]
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL   the DIRECT (non-pooled) endpoint

import type { WebPropertyRegistration } from '@emgloop/database';

export interface WebPropertyRegistrar {
  previewRegistration(organizationId: string, r: WebPropertyRegistration): Promise<{ outcome: 'REGISTERED' | 'UPDATED' | 'UNCHANGED' | 'REFUSED'; problems: readonly string[] }>;
  register(organizationId: string, r: WebPropertyRegistration): Promise<{ outcome: 'REGISTERED' | 'UPDATED' | 'UNCHANGED'; property: { key: string; status: string } } | { outcome: 'REFUSED'; problems: readonly string[] }>;
  setStatus(organizationId: string, key: string, status: 'ACTIVE' | 'DISABLED'): Promise<{ key: string; status: string } | null>;
  findForOrganization(organizationId: string, key: string): Promise<{ key: string; status: string } | null>;
}

/** Read-only organization lookup. This runner never provisions one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; status: string } | null>;
}

export interface RunDeps {
  properties: WebPropertyRegistrar;
  organizations: OrganizationLookup;
  log: (line: string) => void;
}

export type RunAction = 'register' | 'enable' | 'disable';

export interface RunRequest {
  organizationSlug: string;
  action: string;
  key: string;
  label: string | null;
  domains: string[];
  ga4PropertyId: string | null;
  searchConsoleSite: string | null;
  bingSite: string | null;
  clarityProjectId: string | null;
  dryRun: boolean;
}

export type RunOutcome =
  | 'REGISTERED' | 'UPDATED' | 'UNCHANGED' | 'ENABLED' | 'DISABLED'
  | 'WOULD_REGISTER' | 'WOULD_UPDATE' | 'WOULD_BE_UNCHANGED' | 'WOULD_ENABLE' | 'WOULD_DISABLE'
  | 'REFUSED' | 'FAILED_PRECONDITION';

export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields).map(([k, v]) => `${k}=${v === null ? '-' : String(v)}`).join(' ');
}

export function parseArgs(argv: readonly string[]): RunRequest {
  const r: RunRequest = { organizationSlug: '', action: 'register', key: '', label: null, domains: [], ga4PropertyId: null, searchConsoleSite: null, bingSite: null, clarityProjectId: null, dryRun: false };
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
    else if (flag === '--label') r.label = take() || null;
    else if (flag === '--domain') {
      const d = take();
      if (d) r.domains.push(d);
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
  if (!SLUG.test(request.organizationSlug)) return refuse('--organization must be lowercase letters, digits and hyphens');
  if (!['register', 'enable', 'disable'].includes(request.action)) return refuse('--action must be register | enable | disable');
  if (!request.key) return refuse('--key is required');

  const org = await deps.organizations.findBySlug(request.organizationSlug);
  if (!org) return refuse('unknown organization');
  if ((REFUSED_ORGANIZATION_STATUSES as readonly string[]).includes(org.status)) return refuse('organization is not active');
  deps.log(line({ event: 'ORGANIZATION', organization: org.slug, action: request.action, dryRun: request.dryRun }));

  if (request.action !== 'register') {
    const status = request.action === 'enable' ? 'ACTIVE' : 'DISABLED';
    const existing = await deps.properties.findForOrganization(org.id, request.key);
    if (!existing) {
      deps.log(line({ event: 'REFUSED', reason: 'PROPERTY_NOT_IN_ORGANIZATION', written: false }));
      return { outcome: 'REFUSED', problems: ['PROPERTY_NOT_IN_ORGANIZATION'] };
    }
    if (request.dryRun) {
      const would = status === 'ACTIVE' ? 'WOULD_ENABLE' : 'WOULD_DISABLE';
      deps.log(line({ event: 'DRY_RUN_COMPLETE', written: false, wouldBe: would, currentStatus: existing.status }));
      return { outcome: would, problems: [] };
    }
    const updated = await deps.properties.setStatus(org.id, request.key, status);
    deps.log(line({ event: 'STATUS_RESULT', written: true, status: updated?.status ?? null }));
    return { outcome: status === 'ACTIVE' ? 'ENABLED' : 'DISABLED', problems: [] };
  }

  const registration: WebPropertyRegistration = {
    key: request.key,
    label: request.label,
    allowedDomains: request.domains.map((d) => d.toLowerCase()),
    ga4PropertyId: request.ga4PropertyId,
    searchConsoleSiteUrl: request.searchConsoleSite,
    bingSiteUrl: request.bingSite,
    clarityProjectId: request.clarityProjectId,
  };
  const preview = await deps.properties.previewRegistration(org.id, registration);
  deps.log(line({
    event: 'PRE_WRITE_CHECK',
    wouldBe: preview.outcome,
    domains: registration.allowedDomains.length,
    ga4Bound: registration.ga4PropertyId !== null,
    searchConsoleBound: registration.searchConsoleSiteUrl !== null,
    bingBound: registration.bingSiteUrl !== null,
    clarityBound: registration.clarityProjectId !== null,
  }));
  for (const p of preview.problems) deps.log(line({ event: 'PRE_WRITE_PROBLEM', code: CODE.test(p) ? p : 'UNRECOGNIZED' }));
  if (preview.outcome === 'REFUSED') {
    deps.log(line({ event: 'REFUSED', written: false }));
    return { outcome: 'REFUSED', problems: preview.problems };
  }
  if (request.dryRun) {
    const would = preview.outcome === 'REGISTERED' ? 'WOULD_REGISTER' : preview.outcome === 'UPDATED' ? 'WOULD_UPDATE' : 'WOULD_BE_UNCHANGED';
    deps.log(line({ event: 'DRY_RUN_COMPLETE', written: false, wouldBe: would }));
    return { outcome: would, problems: [] };
  }
  const result = await deps.properties.register(org.id, registration);
  if (result.outcome === 'REFUSED') {
    for (const p of result.problems) deps.log(line({ event: 'REGISTRATION_PROBLEM', code: CODE.test(p) ? p : 'UNRECOGNIZED' }));
    deps.log(line({ event: 'REFUSED', written: false }));
    return { outcome: 'REFUSED', problems: result.problems };
  }
  // Read back what was written, from the repository rather than the write's own answer.
  const stored = await deps.properties.findForOrganization(org.id, request.key);
  deps.log(line({ event: 'REGISTRATION_RESULT', result: result.outcome, written: result.outcome !== 'UNCHANGED', readBack: stored ? 'FOUND' : 'MISSING', status: stored?.status ?? null }));
  return { outcome: result.outcome, problems: [] };
}

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');
  if (!process.env.DATABASE_URL?.trim()) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: 'DATABASE_URL' }));
    return 2;
  }
  const { prisma, WebPropertyRepository } = await import('@emgloop/database');
  try {
    const properties = new WebPropertyRepository(prisma);
    const organizations: OrganizationLookup = {
      findBySlug: (slug) => prisma.organization.findUnique({ where: { slug }, select: { id: true, slug: true, status: true } }),
    };
    const result = await runRegisterWebProperty(parseArgs(process.argv.slice(2)), { properties, organizations, log });
    return result.outcome === 'REFUSED' || result.outcome === 'FAILED_PRECONDITION' ? 1 : 0;
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
