// CRM outreach import -- the local operator command (CRM slice 5, PR A).
//
//   validate       --source <file.csv> [--expected-sha256 <hex>]
//                  Parse and shape-check the canonical CSV. No database.
//   inventory      --source <file.csv> --review-dir <dir> [--expected-sha256 <hex>]
//                  Count what the source contains (Part 13). No database. Counts are printed; the
//                  detail (aliases, routes, statuses as written) goes only to the review directory.
//   record-config  --config <file.json> --organization <slug> --actor-user-id <id>|--actor-email <email> [--replace]
//                  Record the reviewed creator aliases and route classifications (OWNER/ADMIN).
//   dry-run        --source <file.csv> --config <file.json> --organization <slug> --actor-user-id|--actor-email
//                  --review-dir <dir> [--expected-sha256 <hex>] [--source-ref <ref>] [--importer-version <v>]
//                  Plan the import, record the run and its entries, write the review artifacts.
//                  Writes NO CRM row.
//   approve        --dry-run-id <id> --organization <slug> --actor-...           (production: reviewed dry-run approval only)
//   apply          --source --config --approval-id --expected-sha256 --organization --actor-...
//                  --confirm "apply <first 12 of sha256>"                         (production only via commissioned workflow, or local test)
//   abandon        --run-id <id> --organization <slug> --actor-...               (local only)
//
// TARGETS (LOOP_CRM_IMPORT_TARGET), checked before the database package is even loaded:
//   local       every command, against a database on this machine only.
//   production  validate, inventory, record-config, dry-run, approve and APPLY, ONLY inside GitHub Actions on
//               refs/heads/main (the "CRM Outreach Import" workflow, connections-production), ONLY
//               for CRM_IMPORT_ORGANIZATION_SLUG. Dry-run/APPLY require the identifier key. APPLY also
//               requires the reviewed approval id, exact source hash/config, typed source-hash confirmation,
//               and the workflow-only production commissioning flag. Abandon remains uncommissioned.
//
// THE SOURCE IS HASHED OVER ITS BYTES AND CHECKED AGAINST --expected-sha256 BEFORE IT IS PARSED.
// Bytes that are not valid UTF-8 are refused, never replaced.
//
// NOTHING SOURCE-DERIVED IS PRINTED. Output is one structured line per event: codes, counts, ids
// and SHA-256s. No email, phone, contact name, title, note, brand or route text reaches stdout --
// those go only to the review artifacts, which are written 0600 into a directory OUTSIDE the
// repository (refused otherwise), so they cannot be committed by accident.
//
// The actor is a real member, named by email and resolved inside the organization; the email is
// never printed. Every act is authorized again by the services, as for anyone else.

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type { CrmImportPrepared } from '@emgloop/database';
import {
  CRM_IMPORT_VERSION,
  crmContactPointSourceRefValid,
  crmImportKey,
  crmImportPersonEligible,
  normalizeCrmContactPointValue,
  parseCrmImportCsv,
  validateCrmImportConfig,
  type CrmImportConfig,
  type CrmImportSourceRow,
} from '@emgloop/shared';

export const COMMANDS = ['validate', 'inventory', 'record-config', 'dry-run', 'approve', 'apply', 'abandon'] as const;
export type Command = (typeof COMMANDS)[number];

export interface Args {
  readonly command: Command | null;
  readonly flags: Readonly<Record<string, string | true>>;
}

export function parseArgs(argv: readonly string[]): Args {
  const [first, ...rest] = argv;
  const command = (COMMANDS as readonly string[]).includes(first ?? '') ? (first as Command) : null;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (!a.startsWith('--')) continue;
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[a.slice(2)] = next;
      i += 1;
    } else flags[a.slice(2)] = true;
  }
  return { command, flags };
}

const REQUIRED: Readonly<Record<Command, readonly string[]>> = {
  validate: ['source'],
  inventory: ['source', 'review-dir'],
  'record-config': ['config', 'organization', 'actor'],
  'dry-run': ['source', 'config', 'organization', 'actor', 'review-dir'],
  approve: ['dry-run-id', 'organization', 'actor'],
  apply: ['source', 'config', 'approval-id', 'expected-sha256', 'organization', 'actor', 'confirm'],
  abandon: ['run-id', 'organization', 'actor'],
};

/** Commands that touch the database. `validate` and `inventory` read only the file. */
const DATABASE_COMMANDS: readonly Command[] = ['record-config', 'dry-run', 'approve', 'apply', 'abandon'];
/** What the production target may run. APPLY is commissioned only behind the workflow/service guards; abandon remains refused. */
export const PRODUCTION_COMMANDS: readonly Command[] = ['validate', 'inventory', 'record-config', 'dry-run', 'approve', 'apply'];

/** The actor is a member named by user id (the workflow's path: no email in a workflow input) or by email (local). */
const hasActor = (args: Args) => ['actor-user-id', 'actor-email'].some((f) => typeof args.flags[f] === 'string' && (args.flags[f] as string).trim() !== '');

export function missingFlags(args: Args): string[] {
  if (!args.command) return ['command'];
  return REQUIRED[args.command].filter((f) => (f === 'actor' ? !hasActor(args) : typeof args.flags[f] !== 'string' || !(args.flags[f] as string).trim())).map((f) => (f === 'actor' ? 'actor-user-id|actor-email' : f));
}

/**
 * The target guard, before any database code loads. The variable is the human (or the workflow)
 * saying which database this is.
 *   local       any command, against a database on this machine only (the host check catches a URL
 *               that says otherwise).
 *   production  validate, inventory, record-config, dry-run, approve and APPLY, ONLY inside GitHub Actions
 *               on refs/heads/main, ONLY for the one organization the environment names. Dry-run/APPLY
 *               require the configured identifier key. The service independently requires the workflow-only
 *               production APPLY commissioning flag. Abandon remains uncommissioned.
 */
export function checkTarget(env: Readonly<Record<string, string | undefined>>, command: Command | null = null, organization: string | null = null): { ok: true } | { ok: false; reason: string } {
  const target = env.LOOP_CRM_IMPORT_TARGET;
  if (target === 'production') {
    if (!command || !PRODUCTION_COMMANDS.includes(command)) return { ok: false, reason: 'PRODUCTION_APPLY_NOT_COMMISSIONED' };
    if (env.GITHUB_ACTIONS !== 'true') return { ok: false, reason: 'PRODUCTION_ONLY_FROM_GITHUB_ACTIONS' };
    if (env.GITHUB_REF !== 'refs/heads/main') return { ok: false, reason: 'PRODUCTION_ONLY_FROM_MAIN' };
    const pinned = (env.CRM_IMPORT_ORGANIZATION_SLUG ?? '').trim();
    if (!pinned) return { ok: false, reason: 'PRODUCTION_ORGANIZATION_NOT_CONFIGURED' };
    if (organization !== null && organization !== pinned) return { ok: false, reason: 'ORGANIZATION_NOT_THE_CONFIGURED_ONE' };
    if ((command === 'dry-run' || command === 'apply') && !(env.COGNITIVE_HASH_SECRET ?? '').length) return { ok: false, reason: 'HASH_KEY_NOT_CONFIGURED' };
    return { ok: true };
  }
  if (target !== 'local') return { ok: false, reason: 'LOOP_CRM_IMPORT_TARGET_MUST_BE_LOCAL_OR_PRODUCTION' };
  if (env.NODE_ENV === 'production') return { ok: false, reason: 'PRODUCTION_RUNTIME_REFUSED' };
  try {
    const host = new URL(env.DATABASE_URL ?? '').hostname;
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) return { ok: false, reason: 'DATABASE_HOST_NOT_LOCAL' };
  } catch {
    return { ok: false, reason: 'DATABASE_URL_INVALID' };
  }
  return { ok: true };
}

/** The phrase an APPLY needs: it names the exact file it applies. */
export function applyConfirmation(sourceSha256: string): string {
  return `apply ${sourceSha256.slice(0, 12)}`;
}

/** Review artifacts never land inside the repository. */
export function reviewDirAllowed(dir: string, repoRoot: string): boolean {
  const rel = relative(resolve(repoRoot), resolve(dir));
  return rel.startsWith('..') || isAbsolute(rel);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function line(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

// --- Reading a source exactly -------------------------------------------------------------------

export type SourceRead =
  | { ok: true; text: string; sha256: string; bytes: number }
  | { ok: false; reason: 'SOURCE_SHA256_MISMATCH' | 'SOURCE_NOT_UTF8' | 'SOURCE_EMPTY' };

/**
 * The SHA-256 is taken over the file's BYTES and checked BEFORE anything parses it. Bytes that are
 * not valid UTF-8 are refused, never replaced: a decoded string must re-encode to exactly the bytes
 * that were hashed and reviewed.
 */
export function readSourceBytes(bytes: Uint8Array, expectedSha256: string | null): SourceRead {
  if (bytes.byteLength === 0) return { ok: false, reason: 'SOURCE_EMPTY' };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 !== null && sha256 !== expectedSha256.trim().toLowerCase()) return { ok: false, reason: 'SOURCE_SHA256_MISMATCH' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'SOURCE_NOT_UTF8' };
  }
  return { ok: true, text, sha256, bytes: bytes.byteLength };
}

// --- Source inventory (Part 13) ------------------------------------------------------------------

export interface SourceInventoryCounts {
  readonly totalRows: number;
  readonly validRows: number;
  readonly invalidRows: number;
  readonly invalidByViolation: Readonly<Record<string, number>>;
  readonly distinctSourceRowKeys: number;
  readonly duplicatedSourceRowKeys: number;
  readonly rowsWithDuplicatedKeys: number;
  readonly distinctCreatorAliases: number;
  /** Rows naming no creator: they may import contacts, never an Opportunity. */
  readonly rowsWithoutCreatorAlias: number;
  readonly distinctRouteKeys: number;
  readonly distinctSourceStatuses: number;
  readonly personEligibleRows: number;
  readonly verifiedNamedRows: number;
  readonly unverifiedOrBlankNameRows: number;
  readonly contactKindIndividual: number;
  readonly contactKindRoleInbox: number;
  readonly contactKindMissing: number;
  readonly emails: number;
  readonly invalidEmails: number;
  readonly phones: number;
  readonly invalidPhones: number;
  readonly rowsWithNoContactValue: number;
  readonly futureLastContacted: number;
  readonly titlesPresent: number;
  readonly notesPresent: number;
}

/** What the source contains, by key, for the PRIVATE review prefix only. Never logged. */
export interface SourceInventoryDetail {
  readonly creatorAliases: readonly { readonly alias: string; readonly key: string; readonly rows: number }[];
  readonly routes: readonly { readonly routeKey: string; readonly key: string; readonly routeNames: readonly string[]; readonly brandNames: readonly string[]; readonly rows: number }[];
  readonly sourceStatuses: readonly { readonly status: string; readonly key: string; readonly rows: number }[];
  readonly duplicatedSourceRowKeys: readonly string[];
  readonly invalidRows: readonly { readonly line: number; readonly sourceRowKey: string | null; readonly violations: readonly string[] }[];
}

export type SourceInventory =
  | { ok: true; counts: SourceInventoryCounts; detail: SourceInventoryDetail }
  | { ok: false; problem: string; column: string | null; position: number | null };

/** Counts of everything the import contract cares about, before any CRM lookup. Pure. */
export function sourceInventory(text: string, now: Date): SourceInventory {
  const parsed = parseCrmImportCsv(text);
  if (!parsed.ok) return { ok: false, problem: parsed.problem, column: parsed.column ?? null, position: parsed.position ?? null };
  const rows = parsed.rows;
  const tally = <T>(items: readonly T[], key: (x: T) => string) => {
    const m = new Map<string, { first: T; n: number }>();
    for (const x of items) {
      const k = key(x);
      const e = m.get(k);
      if (e) e.n += 1;
      else m.set(k, { first: x, n: 1 });
    }
    return m;
  };
  const byRowKey = tally(rows, (r) => r.sourceRowKey);
  const dupKeys = [...byRowKey].filter(([, e]) => e.n > 1);
  const aliases = tally(rows.filter((r) => r.creatorAlias !== null), (r) => crmImportKey(r.creatorAlias));
  const routes = tally(rows, (r) => crmImportKey(r.routeKey));
  const statuses = tally(rows, (r) => crmImportKey(r.sourceStatus));
  const invalidByViolation: Record<string, number> = {};
  for (const i of parsed.invalid) for (const v of i.violations) invalidByViolation[v] = (invalidByViolation[v] ?? 0) + 1;
  const count = (pred: (r: CrmImportSourceRow) => boolean) => rows.filter(pred).length;
  const valid = (kind: 'EMAIL' | 'PHONE', v: string | null) => v !== null && normalizeCrmContactPointValue(kind, v).ok;
  const counts: SourceInventoryCounts = {
    totalRows: rows.length + parsed.invalid.length,
    validRows: rows.length,
    invalidRows: parsed.invalid.length,
    invalidByViolation: Object.fromEntries(Object.entries(invalidByViolation).sort(([a], [b]) => a.localeCompare(b))),
    distinctSourceRowKeys: byRowKey.size,
    duplicatedSourceRowKeys: dupKeys.length,
    rowsWithDuplicatedKeys: dupKeys.reduce((n, [, e]) => n + e.n, 0),
    distinctCreatorAliases: aliases.size,
    rowsWithoutCreatorAlias: count((r) => r.creatorAlias === null),
    distinctRouteKeys: routes.size,
    distinctSourceStatuses: statuses.size,
    personEligibleRows: count((r) => crmImportPersonEligible(r)),
    verifiedNamedRows: count((r) => r.contactNameVerified && Boolean(r.contactName)),
    unverifiedOrBlankNameRows: count((r) => !r.contactNameVerified || !r.contactName),
    contactKindIndividual: count((r) => r.contactKind === 'INDIVIDUAL'),
    contactKindRoleInbox: count((r) => r.contactKind === 'ROLE_INBOX'),
    contactKindMissing: count((r) => r.contactKind === null),
    emails: count((r) => r.email !== null),
    invalidEmails: count((r) => r.email !== null && !valid('EMAIL', r.email)),
    phones: count((r) => r.phone !== null),
    invalidPhones: count((r) => r.phone !== null && !valid('PHONE', r.phone)),
    rowsWithNoContactValue: count((r) => r.email === null && r.phone === null),
    futureLastContacted: count((r) => r.sourceLastContactedAt !== null && Date.parse(r.sourceLastContactedAt) > now.getTime()),
    titlesPresent: count((r) => r.contactTitle !== null),
    notesPresent: count((r) => r.sourceNotes !== null),
  };
  const sortByKey = <T extends { key: string }>(xs: T[]) => xs.sort((a, b) => a.key.localeCompare(b.key));
  const distinct = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => x !== null))].sort();
  const detail: SourceInventoryDetail = {
    creatorAliases: sortByKey([...aliases].map(([key, e]) => ({ alias: e.first.creatorAlias ?? '', key, rows: e.n }))),
    routes: sortByKey(
      [...routes].map(([key, e]) => {
        const of = rows.filter((r) => crmImportKey(r.routeKey) === key);
        return { routeKey: e.first.routeKey, key, routeNames: distinct(of.map((r) => r.routeName)), brandNames: distinct(of.map((r) => r.brandName)), rows: e.n };
      }),
    ),
    sourceStatuses: sortByKey([...statuses].map(([key, e]) => ({ status: e.first.sourceStatus, key, rows: e.n }))),
    duplicatedSourceRowKeys: dupKeys.map(([k]) => k).sort(),
    invalidRows: parsed.invalid.map((i) => ({ line: i.line, sourceRowKey: i.sourceRowKey, violations: i.violations })),
  };
  return { ok: true, counts, detail };
}

// --- Review artifacts --------------------------------------------------------------------------

/** The ordinary review file: decisions and references. No email, phone, title, note or source status. */
export const REVIEW_COLUMNS = [
  'line',
  'source_row_key',
  'route_key',
  'route_classification',
  'creator_alias',
  'creator_resolution',
  'company_action',
  'company_reference',
  'company_name',
  'person_action',
  'person_name',
  'contact_point_actions',
  'opportunity_action',
  'opportunity_title',
  'proposed_category',
  'proposed_stage',
  'owner',
  'relationship_action',
  'outcome',
  'ambiguity_code',
] as const;

/** The protected file adds the source fields a reviewer must see to check a row. Never logged. */
export const PROTECTED_EXTRA_COLUMNS = [
  'source_status',
  'route_name',
  'brand_name',
  'contact_name',
  'contact_name_verified',
  'contact_kind',
  'contact_title',
  'email',
  'phone',
  'source_notes',
  'source_last_contacted_at',
] as const;

export function reviewRows(prepared: Pick<CrmImportPrepared, 'plan' | 'rows' | 'invalid'>): { ordinary: string[][]; protectedRows: string[][] } {
  const byLine = new Map<number, CrmImportSourceRow>(prepared.rows.map((r) => [r.line, r]));
  const pursuits = new Map(prepared.plan.pursuits.map((p) => [p.key, p]));
  const ordinary: string[][] = [[...REVIEW_COLUMNS]];
  const protectedRows: string[][] = [[...REVIEW_COLUMNS, ...PROTECTED_EXTRA_COLUMNS]];
  for (const r of prepared.plan.rows) {
    const src = byLine.get(r.line);
    const pursuit = r.pursuitKey ? pursuits.get(r.pursuitKey) : undefined;
    const base = [
      String(r.line),
      r.sourceRowKey,
      src?.routeKey ?? '',
      r.routeClassification ?? 'UNMAPPED',
      src?.creatorAlias ?? '',
      // NONE: the row names no creator (it can never create an Opportunity). UNMAPPED: it names one nobody mapped.
      r.creatorPartyId ? `MAPPED:${r.creatorPartyId}` : src?.creatorAlias ? 'UNMAPPED' : 'NONE',
      r.companyAction ?? '',
      r.companyKey ?? '',
      r.companyName ?? '',
      r.personAction ?? '',
      r.personKey ? (src?.contactName ?? '') : '',
      r.contacts.map((c) => `${c.kind}:${c.classification}:${c.action}`).join(' '),
      r.opportunityAction,
      pursuit?.title ?? '',
      pursuit?.category ?? '',
      pursuit?.stage ?? '',
      // Decision I: every imported Opportunity begins unassigned. Decision R: no Relationship.
      r.opportunityAction === 'NONE' ? '' : 'UNASSIGNED',
      r.opportunityAction === 'NONE' ? '' : 'NONE',
      r.outcome,
      r.ambiguityCode ?? '',
    ];
    ordinary.push(base);
    protectedRows.push([
      ...base,
      src?.sourceStatus ?? '',
      src?.routeName ?? '',
      src?.brandName ?? '',
      src?.contactName ?? '',
      src ? String(src.contactNameVerified) : '',
      src?.contactKind ?? '',
      src?.contactTitle ?? '',
      src?.email ?? '',
      src?.phone ?? '',
      src?.sourceNotes ?? '',
      src?.sourceLastContactedAt ?? '',
    ]);
  }
  for (const r of prepared.invalid) {
    const row = REVIEW_COLUMNS.map(() => '');
    row[0] = String(r.line);
    row[1] = r.sourceRowKey ?? '';
    row[REVIEW_COLUMNS.indexOf('outcome')] = 'INVALID_ROW';
    row[REVIEW_COLUMNS.indexOf('ambiguity_code')] = r.violations.join(' ');
    ordinary.push(row);
    protectedRows.push([...row, ...PROTECTED_EXTRA_COLUMNS.map(() => '')]);
  }
  const byFirst = (a: string[], b: string[]) => Number(a[0]) - Number(b[0]);
  return { ordinary: [ordinary[0]!, ...ordinary.slice(1).sort(byFirst)], protectedRows: [protectedRows[0]!, ...protectedRows.slice(1).sort(byFirst)] };
}

/** RFC 4180, and a leading = + - @ is neutralized so a spreadsheet never runs a cell as a formula. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const cell = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// --- Wiring ------------------------------------------------------------------------------------

async function readConfig(path: string): Promise<{ ok: true; config: CrmImportConfig } | { ok: false; reason: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'CONFIG_UNREADABLE' };
  }
  const checked = validateCrmImportConfig(raw);
  return checked.ok ? { ok: true, config: checked.config } : { ok: false, reason: `CONFIG_INVALID:${checked.violations.map((v) => `${v.at}:${v.code}`).join(',')}` };
}

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');
  const args = parseArgs(process.argv.slice(2));
  const missing = missingFlags(args);
  if (missing.length > 0) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'MISSING_ARGUMENTS', missing, WROTE: false }));
    return 2;
  }
  const f = (name: string) => String(args.flags[name]);
  const opt = (name: string) => (typeof args.flags[name] === 'string' && (args.flags[name] as string).trim() ? (args.flags[name] as string).trim() : null);
  const command = args.command!;

  // The importer version is pinned by whoever runs it: a plan is never made under another version.
  const pinnedVersion = opt('importer-version');
  if (pinnedVersion !== null && pinnedVersion !== CRM_IMPORT_VERSION) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'IMPORTER_VERSION_MISMATCH', running: CRM_IMPORT_VERSION, WROTE: false }));
    return 2;
  }
  // Provenance of the source: `local`, or the private object and version the workflow read.
  const sourceRef = opt('source-ref') ?? 'local';
  if (!crmContactPointSourceRefValid(sourceRef)) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'SOURCE_REF_INVALID', WROTE: false }));
    return 2;
  }

  // The target guard runs before the database package loads (its client reads DATABASE_URL when
  // constructed), and before anything parses the source.
  const target = checkTarget(process.env, command, opt('organization'));
  if (DATABASE_COMMANDS.includes(command) || process.env.LOOP_CRM_IMPORT_TARGET === 'production') {
    if (!target.ok) {
      log(line({ event: 'PRECONDITION_FAILED', reason: target.reason, WROTE: false }));
      return 2;
    }
  }
  if (opt('review-dir') !== null && !reviewDirAllowed(f('review-dir'), process.cwd())) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'REVIEW_DIR_INSIDE_REPOSITORY', WROTE: false }));
    return 2;
  }

  // The source: its SHA-256 over the bytes, checked BEFORE it is parsed.
  let source: Extract<SourceRead, { ok: true }> | null = null;
  if (opt('source') !== null) {
    const read = readSourceBytes(new Uint8Array(await fs.readFile(f('source'))), command === 'apply' ? f('expected-sha256') : opt('expected-sha256'));
    if (!read.ok) {
      log(line({ event: 'PRECONDITION_FAILED', reason: read.reason, WROTE: false }));
      return 2;
    }
    source = read;
  }

  if (command === 'validate') {
    const parsed = parseCrmImportCsv(source!.text);
    if (!parsed.ok) {
      log(line({ event: 'SOURCE_INVALID', problem: parsed.problem, column: parsed.column ?? null, position: parsed.position ?? null, WROTE: false }));
      return 1;
    }
    log(line({ event: 'VALIDATED', importerVersion: CRM_IMPORT_VERSION, sourceSha256: source!.sha256, bytes: source!.bytes, rows: parsed.rows.length, invalidRows: parsed.invalid.length, invalid: parsed.invalid.map((r) => ({ line: r.line, violations: r.violations })), WROTE: false }));
    return parsed.invalid.length === 0 ? 0 : 1;
  }

  if (command === 'inventory') {
    const inv = sourceInventory(source!.text, new Date());
    if (!inv.ok) {
      log(line({ event: 'SOURCE_INVALID', problem: inv.problem, column: inv.column, position: inv.position, WROTE: false }));
      return 1;
    }
    const dir = resolve(f('review-dir'));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // The detail (aliases, routes, statuses, as the source writes them) goes to the private review
    // file only. The log carries counts.
    await fs.writeFile(resolve(dir, `crm-import-inventory-${source!.sha256.slice(0, 12)}.json`), JSON.stringify({ importerVersion: CRM_IMPORT_VERSION, sourceSha256: source!.sha256, sourceRef, counts: inv.counts, detail: inv.detail }, null, 2), { mode: 0o600 });
    log(line({ event: 'INVENTORY', importerVersion: CRM_IMPORT_VERSION, sourceSha256: source!.sha256, bytes: source!.bytes, counts: inv.counts, reviewArtifacts: 1, WROTE: false }));
    return 0;
  }

  const db = await import('@emgloop/database');
  const { prisma, repositories } = db;
  try {
    const org = await repositories.organizations.findBySlug(f('organization'));
    if (!org) {
      log(line({ event: 'PRECONDITION_FAILED', reason: 'ORGANIZATION_NOT_FOUND', WROTE: false }));
      return 2;
    }
    // The actor: a member of THIS organization, named by user id (no email ever in a workflow input) or by email.
    const userId = opt('actor-user-id');
    const user = userId !== null ? await repositories.iam.getUser(org.id, userId) : await repositories.auth.findUserByEmail(org.id, f('actor-email'));
    if (!user) {
      log(line({ event: 'PRECONDITION_FAILED', reason: 'ACTOR_NOT_A_MEMBER', WROTE: false }));
      return 2;
    }
    const actor = { organizationId: org.id, userId: user.id };

    if (command === 'record-config') {
      const cfg = await readConfig(f('config'));
      if (!cfg.ok) {
        log(line({ event: 'PRECONDITION_FAILED', reason: cfg.reason, WROTE: false }));
        return 2;
      }
      const r = await new db.CrmImportConfigService(prisma).record(actor, cfg.config, { replace: args.flags.replace === true });
      log(line({ event: 'CONFIG', outcome: r.outcome, items: 'items' in r ? r.items.map((i) => ({ kind: i.kind, outcome: i.outcome, reason: i.reason, mappingId: i.mappingId })) : undefined, violations: 'violations' in r ? r.violations : undefined, WROTE: r.outcome === 'RECORDED' }));
      return r.outcome === 'RECORDED' ? 0 : 1;
    }

    const service = new db.CrmImportService(prisma);

    if (command === 'approve') {
      const r = await service.approve(actor, f('dry-run-id'));
      log(line({ event: 'APPROVAL', ...r, WROTE: r.outcome === 'APPROVED' }));
      return r.outcome === 'APPROVED' ? 0 : 1;
    }
    if (command === 'abandon') {
      const r = await service.abandon(actor, f('run-id'));
      log(line({ event: 'ABANDON', ...r, WROTE: r.outcome === 'ABANDONED' }));
      return r.outcome === 'ABANDONED' ? 0 : 1;
    }

    const cfg = await readConfig(f('config'));
    if (!cfg.ok) {
      log(line({ event: 'PRECONDITION_FAILED', reason: cfg.reason, WROTE: false }));
      return 2;
    }
    const importSource = { csvText: source!.text, sourceRef };

    if (command === 'dry-run') {
      const r = await service.dryRun(actor, importSource, cfg.config.stageMapping);
      if (r.outcome !== 'OK') {
        log(line({ event: 'DRY_RUN_REFUSED', ...r, WROTE: false }));
        return 1;
      }
      const dir = resolve(f('review-dir'));
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const review = reviewRows(r.prepared);
      await fs.writeFile(resolve(dir, `crm-import-review-${r.runId}.csv`), toCsv(review.ordinary), { mode: 0o600 });
      await fs.writeFile(resolve(dir, `crm-import-review-PROTECTED-${r.runId}.csv`), toCsv(review.protectedRows), { mode: 0o600 });
      log(line({ event: 'DRY_RUN', runId: r.runId, importerVersion: r.prepared.importerVersion, keyFingerprint: r.prepared.keyFingerprint, sourceSha256: r.prepared.sourceSha256, configFingerprint: r.prepared.configFingerprint, planDigest: r.prepared.planDigest, counts: r.prepared.counts, reviewArtifacts: 2, WROTE_CRM: false }));
      return 0;
    }

    // apply: local test, or the separately commissioned production workflow path.
    if (f('confirm').trim() !== applyConfirmation(source!.sha256)) {
      log(line({ event: 'PRECONDITION_FAILED', reason: 'CONFIRMATION_MISMATCH', expected: 'apply <first 12 hex of the source SHA-256>', WROTE: false }));
      return 2;
    }
    const r = await service.apply(actor, { source: importSource, stageMapping: cfg.config.stageMapping, approvalId: f('approval-id'), executionTarget: process.env.LOOP_CRM_IMPORT_TARGET === 'production' ? 'PRODUCTION' : 'LOCAL_TEST' });
    log(line({ event: 'APPLY', ...r }));
    return r.outcome === 'APPLIED' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

/** A Prisma error code (`P` + four digits) and nothing else, or null. */
export function prismaErrorCode(error: unknown): string | null {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^P\d{4}$/.test(code) ? code : null;
}

const ENTRY_POINT = /[\\/]crm-import\.ts$/;
if (process.argv[1] && ENTRY_POINT.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // The error's class, and a Prisma error code (e.g. P2028, an expired transaction) when there is
      // one -- never its message or meta, which could carry source text.
      process.stdout.write(line({ event: 'RUN_FAILED', reason: error instanceof Error ? error.name : 'unknown', code: prismaErrorCode(error) }) + '\n');
      process.exitCode = 1;
    },
  );
}
