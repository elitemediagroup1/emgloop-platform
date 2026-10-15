// Manual, reviewed cost-only recovery. Ordinary convergence remains unchanged.
import { createHash } from 'node:crypto';
import { runFinancialAudit, parseAuditArgs, type AuditDeps } from './audit-callgrid-financials';
import type { MarketplaceCallRepository } from '@emgloop/database';

type Audit = Awaited<ReturnType<typeof runFinancialAudit>>;
export function planCostCorrection(audit: Audit) {
  const r = audit.read;
  if (!r.complete || r.providerRecords !== audit.providerCanonicalTotals.calls || r.providerOutcome !== 'COMPLETE' || r.refusedRecords || r.providerDuplicates || r.localDuplicates ||
    r.localCapped || r.unprojectable || r.outOfWindow || audit.summary.unmatchedCalls ||
    audit.rows.some(row => row.identityStatus !== 'BOTH' || row.fields.costCents.providerCanonicalCents === null)) {
    throw new Error('COMPLETE_COST_EVIDENCE_REQUIRED');
  }
  const changes = audit.rows.flatMap(row => {
    const cost = row.fields.costCents;
    return cost.loopCents === cost.providerCanonicalCents ? [] : [{
      externalId: row.callId, fromCents: cost.loopCents, toCents: cost.providerCanonicalCents!, campaign: row.campaign,
    }];
  });
  if (changes.length > 500 || changes.some(c => !Number.isSafeInteger(c.toCents) || c.toCents < 0 ||
    (c.fromCents !== null && (!Number.isSafeInteger(c.fromCents) || c.fromCents < 0)))) throw new Error('INVALID_COST_PLAN');
  const body = { organization: audit.organization, organizationId: audit.organizationId,
    businessDate: audit.businessDate, since: audit.since, untilExclusive: audit.untilExclusive,
    // Bind approval to the entire day's identity/cost snapshot, not merely its sum.
    evidence: audit.rows.map(row => ({ callId: row.callId, providerCents: row.fields.costCents.providerCanonicalCents, loopCents: row.fields.costCents.loopCents })), changes };
  return { ...body, digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

export interface CostCorrectionRequest {
  organization: string; date: string; apiKey: string; now: Date;
  mode: 'preview' | 'apply'; expectedDigest?: string; confirmation?: string; reviewedBy?: string;
}
export async function runCostCorrection(request: CostCorrectionRequest, deps: AuditDeps & {
  corrections: Pick<MarketplaceCallRepository, 'applyReviewedCosts'>;
}) {
  if (request.mode !== 'preview' && request.mode !== 'apply') throw new Error('INVALID_MODE');
  if (request.mode === 'apply' && (request.confirmation !== `CORRECT COSTS ${request.organization} ${request.date}` ||
    !/^[a-f0-9]{64}$/.test(request.expectedDigest ?? '') || !/^[a-zA-Z0-9-]{1,100}$/.test(request.reviewedBy ?? ''))) {
    throw new Error('REVIEW_REQUIRED');
  }
  const audit = await runFinancialAudit(request, deps);
  const plan = planCostCorrection(audit);
  if (request.mode === 'preview') return { schema: 'callgrid-cost-correction.v1', outcome: 'PREVIEW', plan, applied: 0 };
  if (plan.digest !== request.expectedDigest) throw new Error('COST_PLAN_CHANGED_REVIEW_AGAIN');
  const applied = await deps.corrections.applyReviewedCosts(audit.organizationId, {
    organizationSlug: audit.organization, since: new Date(audit.since), until: new Date(audit.untilExclusive),
    observedAt: request.now, digest: plan.digest, reviewedBy: request.reviewedBy!, changes: plan.changes,
  });
  return { schema: 'callgrid-cost-correction.v1', outcome: 'APPLIED', plan, applied };
}

export async function main(): Promise<number> {
  const args = parseAuditArgs(['--organization', process.env.ORG_SLUG ?? '', '--date', process.env.BUSINESS_DATE ?? '']);
  const mode = process.env.COST_MODE ?? 'preview';
  if (mode !== 'preview' && mode !== 'apply') throw new Error('INVALID_MODE');
  if (!process.env.DATABASE_URL?.trim() || !process.env.CALLGRID_API_KEY?.trim()) throw new Error('REQUIRED_CREDENTIAL_MISSING');
  process.env.LOOP_PRISMA_LOG = 'none';
  const { prisma, repositories } = await import('@emgloop/database');
  const { readCallGridInterval } = await import('@emgloop/providers');
  try {
    const result = await runCostCorrection({ ...args, apiKey: process.env.CALLGRID_API_KEY, now: new Date(), mode,
      expectedDigest: process.env.EXPECTED_DIGEST ?? '', confirmation: process.env.CONFIRMATION ?? '', reviewedBy: process.env.REVIEWED_BY ?? '',
    }, { organizations: repositories.organizations, calls: repositories.marketplaceCalls,
      provider: { read: readCallGridInterval }, corrections: repositories.marketplaceCalls });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } finally { await prisma.$disconnect(); }
}
if (process.argv[1] && /[\\/]correct-callgrid-costs\.ts$/.test(process.argv[1])) {
  main().then(code => { process.exitCode = code; }, () => {
    process.stdout.write(JSON.stringify({ schema: 'callgrid-cost-correction.v1', outcome: 'REFUSED_OR_FAILED', error: 'COST_CORRECTION_NOT_COMPLETED' }) + '\n');
    process.exitCode = 1;
  });
}
