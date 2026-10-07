// CRM outreach import -- the local operator command (CRM slice 5, PR A).
//
//   validate       --source <file.csv>
//                  Parse and shape-check the canonical CSV. No database.
//   record-config  --config <file.json> --organization <slug> --actor-email <email> [--replace]
//                  Record the reviewed creator aliases and route classifications (OWNER/ADMIN).
//   dry-run        --source <file.csv> --config <file.json> --organization <slug> --actor-email <email> --review-dir <dir>
//                  Plan the import, record the run and its entries, write the review artifacts.
//                  Writes NO CRM row.
//   approve        --dry-run-id <id> --organization <slug> --actor-email <email>
//                  Approve one successful dry run for APPLY (OWNER/ADMIN).
//   apply          --source <file.csv> --config <file.json> --approval-id <id> --expected-sha256 <hex>
//                  --organization <slug> --actor-email <email> --confirm "apply <first 12 of sha256>"
//                  Execute an approved plan through the governed services. LOCAL / TEST DATABASES ONLY.
//   abandon        --run-id <id> --organization <slug> --actor-email <email>
//                  Release an APPLY whose process died (OWNER/ADMIN).
//
// THE PRODUCTION PATH IS NOT COMMISSIONED. Before the database package is even loaded this refuses
// unless LOOP_CRM_IMPORT_TARGET is exactly "local" AND the DATABASE_URL host is this machine. The
// private-S3 + GitHub OIDC production path (and a production dry run) is PR B; until it exists,
// "production" is refused by name, and the import service refuses a non-local APPLY on its own.
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
import { CRM_IMPORT_VERSION, parseCrmImportCsv, validateCrmImportConfig, type CrmImportConfig, type CrmImportSourceRow } from '@emgloop/shared';

export const COMMANDS = ['validate', 'record-config', 'dry-run', 'approve', 'apply', 'abandon'] as const;
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
  'record-config': ['config', 'organization', 'actor-email'],
  'dry-run': ['source', 'config', 'organization', 'actor-email', 'review-dir'],
  approve: ['dry-run-id', 'organization', 'actor-email'],
  apply: ['source', 'config', 'approval-id', 'expected-sha256', 'organization', 'actor-email', 'confirm'],
  abandon: ['run-id', 'organization', 'actor-email'],
};

export function missingFlags(args: Args): string[] {
  if (!args.command) return ['command'];
  return REQUIRED[args.command].filter((f) => typeof args.flags[f] !== 'string' || !(args.flags[f] as string).trim());
}

/**
 * The target guard, before any database code loads. Local only in PR A: the variable is the human
 * saying which database this is, and the host check catches a URL that says otherwise.
 */
export function checkTarget(env: Readonly<Record<string, string | undefined>>): { ok: true } | { ok: false; reason: string } {
  const target = env.LOOP_CRM_IMPORT_TARGET;
  if (target === 'production') return { ok: false, reason: 'PRODUCTION_PATH_NOT_COMMISSIONED' };
  if (target !== 'local') return { ok: false, reason: 'LOOP_CRM_IMPORT_TARGET_MUST_BE_LOCAL' };
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
      r.creatorPartyId ? `MAPPED:${r.creatorPartyId}` : 'UNMAPPED',
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

  if (args.command === 'validate') {
    const text = await fs.readFile(f('source'), 'utf8');
    const parsed = parseCrmImportCsv(text);
    if (!parsed.ok) {
      log(line({ event: 'SOURCE_INVALID', problem: parsed.problem, column: parsed.column ?? null, WROTE: false }));
      return 1;
    }
    log(line({ event: 'VALIDATED', importerVersion: CRM_IMPORT_VERSION, sourceSha256: sha256Hex(text), rows: parsed.rows.length, invalidRows: parsed.invalid.length, invalid: parsed.invalid.map((r) => ({ line: r.line, violations: r.violations })), WROTE: false }));
    return parsed.invalid.length === 0 ? 0 : 1;
  }

  const target = checkTarget(process.env);
  if (!target.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: target.reason, WROTE: false }));
    return 2;
  }
  if (args.command === 'dry-run' && !reviewDirAllowed(f('review-dir'), process.cwd())) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'REVIEW_DIR_INSIDE_REPOSITORY', WROTE: false }));
    return 2;
  }

  const db = await import('@emgloop/database');
  const { prisma, repositories } = db;
  try {
    const org = await repositories.organizations.findBySlug(f('organization'));
    if (!org) {
      log(line({ event: 'PRECONDITION_FAILED', reason: 'ORGANIZATION_NOT_FOUND', WROTE: false }));
      return 2;
    }
    const user = await repositories.auth.findUserByEmail(org.id, f('actor-email'));
    if (!user) {
      log(line({ event: 'PRECONDITION_FAILED', reason: 'ACTOR_NOT_A_MEMBER', WROTE: false }));
      return 2;
    }
    const actor = { organizationId: org.id, userId: user.id };

    if (args.command === 'record-config') {
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

    if (args.command === 'approve') {
      const r = await service.approve(actor, f('dry-run-id'));
      log(line({ event: 'APPROVAL', ...r, WROTE: r.outcome === 'APPROVED' }));
      return r.outcome === 'APPROVED' ? 0 : 1;
    }
    if (args.command === 'abandon') {
      const r = await service.abandon(actor, f('run-id'));
      log(line({ event: 'ABANDON', ...r, WROTE: r.outcome === 'ABANDONED' }));
      return r.outcome === 'ABANDONED' ? 0 : 1;
    }

    const cfg = await readConfig(f('config'));
    if (!cfg.ok) {
      log(line({ event: 'PRECONDITION_FAILED', reason: cfg.reason, WROTE: false }));
      return 2;
    }
    const csvText = await fs.readFile(f('source'), 'utf8');
    const source = { csvText, sourceRef: 'local' };

    if (args.command === 'dry-run') {
      const r = await service.dryRun(actor, source, cfg.config.stageMapping);
      if (r.outcome !== 'OK') {
        log(line({ event: 'DRY_RUN_REFUSED', ...r, WROTE: false }));
        return 1;
      }
      const dir = resolve(f('review-dir'));
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const review = reviewRows(r.prepared);
      await fs.writeFile(resolve(dir, `crm-import-review-${r.runId}.csv`), toCsv(review.ordinary), { mode: 0o600 });
      await fs.writeFile(resolve(dir, `crm-import-review-PROTECTED-${r.runId}.csv`), toCsv(review.protectedRows), { mode: 0o600 });
      log(line({ event: 'DRY_RUN', runId: r.runId, importerVersion: r.prepared.importerVersion, sourceSha256: r.prepared.sourceSha256, configFingerprint: r.prepared.configFingerprint, planDigest: r.prepared.planDigest, counts: r.prepared.counts, reviewArtifacts: 2, WROTE_CRM: false }));
      return 0;
    }

    // apply
    const sha = sha256Hex(csvText);
    if (sha !== f('expected-sha256')) {
      log(line({ event: 'PRECONDITION_FAILED', reason: 'SOURCE_SHA256_MISMATCH', WROTE: false }));
      return 2;
    }
    if (f('confirm').trim() !== applyConfirmation(sha)) {
      log(line({ event: 'PRECONDITION_FAILED', reason: 'CONFIRMATION_MISMATCH', expected: 'apply <first 12 hex of the source SHA-256>', WROTE: false }));
      return 2;
    }
    const r = await service.apply(actor, { source, stageMapping: cfg.config.stageMapping, approvalId: f('approval-id'), executionTarget: 'LOCAL_TEST' });
    log(line({ event: 'APPLY', ...r }));
    return r.outcome === 'APPLIED' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

const ENTRY_POINT = /[\\/]crm-import\.ts$/;
if (process.argv[1] && ENTRY_POINT.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // The error's class only: a message could carry source text.
      process.stdout.write(line({ event: 'RUN_FAILED', reason: error instanceof Error ? error.name : 'unknown' }) + '\n');
      process.exitCode = 1;
    },
  );
}
