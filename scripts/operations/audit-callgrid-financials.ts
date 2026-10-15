// Read-only, one completed Eastern day. No ingestion, correction or checkpoint write.
// The provider's canonical bounded reader and the production projection's pure mapper
// are reused. Raw payloads, credentials and caller details never enter the output.
import { easternBusinessDayWindow, isBusinessDate } from '@emgloop/shared';
import type { InboundEvent } from '@emgloop/providers';
import type { IntervalReadOutcome } from '../../packages/providers/src/adapters/callgrid-interval';
import type { MarketplaceCallRepository } from '@emgloop/database';
import { projectCallObservation } from '../../packages/database/src/repositories/marketplace-call-projection';

export const AUDIT_LIMIT = 10_000;
const FIELDS = ['revenueCents', 'payoutCents', 'costCents'] as const;
type Field = (typeof FIELDS)[number];
type Amounts = Record<Field, number | null>;
function mapFields<T>(value: (field: Field) => T): Record<Field, T> {
  return Object.fromEntries(FIELDS.map((field) => [field, value(field)])) as Record<Field, T>;
}
type LocalCall = Awaited<ReturnType<MarketplaceCallRepository['listWindowForReconciliation']>>[number];
interface ProviderRead {
  outcome: IntervalReadOutcome;
  events: InboundEvent[];
  records: number;
  pages: number;
  refused: readonly unknown[];
}
export interface AuditDeps {
  organizations: { findBySlug(slug: string): Promise<{ id: string; status: string } | null> };
  calls: Pick<MarketplaceCallRepository, 'listWindowForReconciliation'>;
  provider: { read(input: { apiKey: string; since: Date; until: Date; maxPages: number }): Promise<ProviderRead> };
}

export function parseAuditArgs(argv: readonly string[]): { organization: string; date: string } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag || !['--organization', '--date'].includes(flag) || !value || args.has(flag)) throw new Error('INVALID_ARGUMENTS');
    args.set(flag, value);
  }
  const organization = args.get('--organization') ?? '';
  const date = args.get('--date') ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(organization) || !isBusinessDate(date)) throw new Error('INVALID_ARGUMENTS');
  return { organization, date };
}

function amounts(row: Amounts): Amounts {
  return { revenueCents: row.revenueCents, payoutCents: row.payoutCents, costCents: row.costCents };
}

// Raw provider decimal-dollar values remain visible beside canonical integer cents.
// This can expose sub-cent input or a canonical rounding edge; it does NOT claim
// the list endpoint's total is the same calculation as CallGrid's report UI.
function decimal(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return String(value).trim() !== '' && Number.isFinite(n) ? String(value).trim() : null;
}

function totals(rows: readonly Amounts[]) {
  const fields = mapFields((field) => {
    const known = rows.filter((row) => row[field] !== null);
    return {
      sumReportedCents: rows.length === 0 ? 0 : known.length === 0 ? null : known.reduce((sum, row) => sum + row[field]!, 0),
      reportedCalls: known.length, missingCalls: rows.length - known.length,
    };
  });
  const complete = rows.filter((row) => FIELDS.every((field) => row[field] !== null));
  return {
    calls: rows.length, fields,
    completeEconomicsCalls: complete.length,
    netProfitOnCompleteCallsCents: rows.length === 0 ? 0 : complete.length === 0 ? null : complete.reduce((sum, row) => sum + row.revenueCents! - row.payoutCents! - row.costCents!, 0),
  };
}

export async function runFinancialAudit(
  request: { organization: string; date: string; apiKey: string; now: Date }, deps: AuditDeps,
) {
  // Validate before any lookup, provider request or database read.
  const args = parseAuditArgs(['--organization', request.organization, '--date', request.date]);
  if (!request.apiKey.trim() || !Number.isFinite(request.now.getTime())) throw new Error('INVALID_ENVIRONMENT');
  if (!isBusinessDate(args.date)) throw new Error('INVALID_DATE');
  const window = easternBusinessDayWindow(args.date);
  if (window.end > request.now) throw new Error('COMPLETED_DAY_REQUIRED');
  const org = await deps.organizations.findBySlug(args.organization);
  if (!org || org.status !== 'ACTIVE') throw new Error('ACTIVE_ORGANIZATION_REQUIRED');
  const provider = await deps.provider.read({ apiKey: request.apiKey, since: window.start, until: window.end, maxPages: 100 });
  const localRead = await deps.calls.listWindowForReconciliation(org.id, window.start, window.end, AUDIT_LIMIT + 1, 'callgrid');
  const localCapped = localRead.length > AUDIT_LIMIT;
  const local = localRead.slice(0, AUDIT_LIMIT);
  const source = new Map<string, { amounts: Amounts; raw: Record<string, string | null>; campaign: string | null }>();
  let providerDuplicates = 0;
  let unprojectable = 0;
  let outOfWindow = 0;
  for (const event of provider.events.slice(0, AUDIT_LIMIT)) {
    if (event.occurredAt < window.start || event.occurredAt >= window.end) { outOfWindow += 1; continue; }
    const projected = projectCallObservation({ organizationId: org.id, provider: 'callgrid', externalId: event.externalId, channel: 'PHONE', occurredAt: event.occurredAt, metadata: { ...event.payload, eventType: 'call.completed' }, interactionId: null });
    if (!projected) { unprojectable += 1; continue; }
    if (source.has(projected.externalId)) { providerDuplicates += 1; continue; }
    source.set(projected.externalId, {
      amounts: amounts(projected), campaign: projected.campaignLabel,
      raw: { revenue: decimal(event.payload.CallRevenue ?? event.payload.revenue), payout: decimal(event.payload.CallPayout ?? event.payload.payout), cost: decimal(event.payload.CallCost ?? event.payload.cost ?? event.payload.telco) },
    });
  }
  const localById = new Map(local.map((row) => [row.externalId, row]));
  const localDuplicates = local.length - localById.size;
  const readComplete = provider.outcome === 'COMPLETE' && provider.refused.length === 0 && !localCapped && provider.events.length <= AUDIT_LIMIT && providerDuplicates === 0 && localDuplicates === 0 && unprojectable === 0 && outOfWindow === 0;
  let mismatches = 0;
  let unknownFields = 0;
  let unmatched = 0;
  const rows = [...new Set([...source.keys(), ...localById.keys()])].sort().map((id) => {
    const p = source.get(id);
    const l = localById.get(id);
    const identityStatus = p && l ? 'BOTH' : !readComplete ? 'UNVERIFIED_ABSENCE' : p ? 'PROVIDER_ONLY' : 'LOOP_ONLY';
    if (!p || !l) unmatched += 1;
    const fields = mapFields((field) => {
      const expected = p?.amounts[field] ?? null;
      const actual = l?.[field] ?? null;
      const status = !p || !l || expected === null || actual === null ? 'UNKNOWN' : expected === actual ? 'MATCH' : 'MISMATCH';
      if (status === 'MISMATCH') mismatches += 1;
      if (status === 'UNKNOWN') unknownFields += 1;
      return { providerCanonicalCents: expected, loopCents: actual, loopMinusProviderCents: expected === null || actual === null ? null : actual - expected, status };
    });
    return { callId: id, campaign: p?.campaign ?? l?.campaignLabel ?? null, identityStatus, providerDecimalDollars: p?.raw ?? null, fields };
  });
  return {
    schema: 'callgrid-financial-audit.v1', organization: args.organization, organizationId: org.id, businessDate: args.date,
    timezone: 'America/New_York', since: window.start.toISOString(), untilExclusive: window.end.toISOString(), requestedAt: request.now.toISOString(),
    verdict: !readComplete ? 'INCONCLUSIVE' : mismatches > 0 || unmatched > 0 ? 'DIFFERS' : unknownFields > 0 ? 'INCONCLUSIVE' : 'MATCHED_REPORTED_FIELDS',
    read: { complete: readComplete, providerOutcome: provider.outcome, providerRecords: provider.records, providerPages: provider.pages, refusedRecords: provider.refused.length, providerDuplicates, localDuplicates, localCapped, unprojectable, outOfWindow },
    summary: { mismatchedFields: mismatches, unknownFields, unmatchedCalls: unmatched },
    providerCanonicalTotals: totals([...source.values()].map((row) => row.amounts)), loopTotals: totals(local),
    limitations: [
      'Read-only. No ingestion, correction, revision, checkpoint or certification is written.',
      'Provider and database reads are not an atomic snapshot; later postbacks may change either side.',
      'Missing provider cost stays unknown. A complete list read is not financial completeness.',
      'Amounts compare against the current canonical mapper with zero-cent tolerance. Raw decimal dollars are retained to investigate precision; the report UI may aggregate differently.',
      'MATCHED_REPORTED_FIELDS is not a provider report-UI, campaign-scope or historical-day certificate.',
      'Call IDs and campaign labels are business evidence. No caller numbers, recordings, transcripts or raw payloads are included.',
    ], rows,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseAuditArgs(argv);
  if (!process.env.DATABASE_URL?.trim() || !process.env.CALLGRID_API_KEY?.trim()) throw new Error('REQUIRED_CREDENTIAL_MISSING');
  // Prisma exception logging may contain arguments. Only this runner's fixed
  // failure code is emitted; do this before the lazy client is constructed.
  process.env.LOOP_PRISMA_LOG = 'none';
  const { prisma, repositories } = await import('@emgloop/database');
  const { readCallGridInterval } = await import('@emgloop/providers');
  try {
    const report = await runFinancialAudit({ ...args, apiKey: process.env.CALLGRID_API_KEY, now: new Date() }, { organizations: repositories.organizations, calls: repositories.marketplaceCalls, provider: { read: readCallGridInterval } });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    // A finding is not a failed execution. The report verdict, not job colour,
    // states whether evidence matched or was sufficient.
    return 0;
  } finally { await prisma.$disconnect(); }
}

if (process.argv[1] && /[\\/]audit-callgrid-financials\.ts$/.test(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }, () => {
    // Never print provider/database exception text: it may echo credentials.
    process.stdout.write(JSON.stringify({ schema: 'callgrid-financial-audit.v1', verdict: 'FAILED', error: 'AUDIT_EXECUTION_FAILED' }) + '\n');
    process.exitCode = 1;
  });
}
