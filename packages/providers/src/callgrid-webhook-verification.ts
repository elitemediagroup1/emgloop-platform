// @emgloop/providers - CallGrid webhook parser verification harness (pure,
// framework-free). PR #41 (CallGrid ingestion truth fix).
//
// Proves, deterministically and without any test framework, that
// CallGridProvider.parseWebhook() correctly reads the CONFIRMED canonical
// CallGrid webhook body (see the PR description for the exact
// [[category:VariableName]] template CallGrid's own "Insert tag" picker
// produces) into the canonical Interaction.metadata keys the rest of the Loop
// reads - WITHOUT fabricating any value CallGrid did not actually send, and
// WITHOUT defaulting an unrecognized status to 'completed'.
//
// The repo intentionally ships no test runner (only 'typecheck'/'build' via
// turbo, per the platform's standing constraints). This harness is a set of
// PURE async functions: fixed input payloads, run through the REAL
// parseWebhook() implementation, checked with a tiny internal assert helper.
// It performs NO I/O, NO network calls, NO DB writes, and is NOT wired into
// any runtime. It compiles as part of the normal typecheck/build (the green
// preview proves that); a caller may additionally invoke
// runCallGridWebhookVerification() at runtime to execute the checks.

import { CallGridProvider } from './adapters/callgrid.provider';
import type { ProviderContext } from './types';

export interface CheckResult {
    name: string;
    passed: boolean;
    detail?: string;
}
export interface ScenarioResult {
    scenario: string;
    checks: CheckResult[];
    passed: boolean;
}
export interface VerificationReport {
    passed: boolean;
    total: number;
    failures: number;
    scenarios: ScenarioResult[];
}

/** A minimal check recorder - the entire "framework". Pure: it only
 * accumulates results into the array it is given. */
class Checker {
    readonly checks: CheckResult[] = [];
    ok(name: string, condition: boolean, detail?: string): void {
          this.checks.push({ name, passed: condition, detail: condition ? undefined : (detail ?? 'expected true') });
    }
    eq<T>(name: string, actual: T, expected: T): void {
          const passed = actual === expected;
          this.ok(name, passed, passed ? undefined : 'expected ' + String(expected) + ', got ' + String(actual));
    }
}

function finalize(scenario: string, c: Checker): ScenarioResult {
    return { scenario, checks: c.checks, passed: c.checks.every((x) => x.passed) };
}

const CTX: ProviderContext = { organizationId: 'org_verify', credentials: {}, config: {} };
const provider = new CallGridProvider();

/** The CONFIRMED canonical CallGrid webhook body: a flat JSON object using the
 * real tag names available in CallGrid's own "Insert tag" picker, every value
 * a string (CallGrid's template substitution always yields strings). */
export const CANONICAL_WEBHOOK_BODY: Record<string, unknown> = {
    id: 'cg_call_12345',
    callStatus: 'COMPLETED',
    endedBy: 'buyer',
    occurredAtUnix: '1735689600',
    callerId: '+15551234567',
    vendorId: 'ven_9001',
    vendorName: 'Acme Traffic',
    sourceId: 'src_4002',
    sourceName: 'Google Ads',
    campaignId: 'cmp_7003',
    campaignName: 'Final Expense Q1',
    buyerId: 'buy_2004',
    buyerName: 'Sunrise Insurance',
    destinationId: 'dst_5005',
    destinationName: 'Sunrise Sales Line',
    inboundState: 'TX',
    inboundZip: '75201',
    durationSeconds: '184',
    billable: 'true',
    paid: 'true',
    converted: 'true',
    completed: 'true',
    noRoute: 'false',
    revenue: '28.50',
    payout: '19.00',
    cost: '1.10',
};

/** A payload with an unrecognized status and every optional field omitted, so
 * the harness proves missing data stays "unknown" instead of being fabricated
 * into zero / false / completed. */
export const MINIMAL_UNKNOWN_BODY: Record<string, unknown> = {
    id: 'cg_call_minimal',
    callStatus: 'SOMETHING_NEW_CALLGRID_ADDED',
};

/** A legacy/older-style test payload (pre-canonical field names) that must
 * keep working unchanged - the backward-compatibility requirement. */
export const LEGACY_TEST_BODY: Record<string, unknown> = {
    call_id: 'legacy_1',
    status: 'completed',
    from: '+15559990000',
    vendor: 'Legacy Vendor',
    duration: '42',
    billable: 'yes',
    revenue: '10',
    payout: '5',
};

async function verifyCanonicalBodyParsesFully(): Promise<ScenarioResult> {
    const c = new Checker();
    const events = await provider.parseWebhook(CTX, CANONICAL_WEBHOOK_BODY);
    c.eq('exactly one event produced', events.length, 1);
    const ev = events[0];
    const p = (ev?.payload ?? {}) as Record<string, unknown>;
    c.eq('externalId read from id', ev?.externalId, 'cg_call_12345');
    c.eq('rawEventType read from callStatus', ev?.rawEventType, 'COMPLETED');
    c.eq('caller read from callerId', p['caller'], '+15551234567');
    c.eq('fromNumber read from callerId', p['fromNumber'], '+15551234567');
    c.eq('vendorId preserved', p['vendorId'], 'ven_9001');
    c.eq('vendor name preserved', p['vendor'], 'Acme Traffic');
    c.eq('sourceId preserved', p['sourceId'], 'src_4002');
    c.eq('source name preserved', p['source'], 'Google Ads');
    c.eq('campaignId preserved', p['campaignId'], 'cmp_7003');
    c.eq('campaign name preserved', p['campaign'], 'Final Expense Q1');
    c.eq('buyerId preserved', p['buyerId'], 'buy_2004');
    c.eq('buyer name preserved', p['buyer'], 'Sunrise Insurance');
    c.eq('destinationId preserved', p['destinationId'], 'dst_5005');
    c.eq('destination name preserved', p['destination'], 'Sunrise Sales Line');
    c.eq('inbound state preserved', p['callerState'], 'TX');
    c.eq('inbound zip preserved', p['callerZip'], '75201');
    c.eq('durationSeconds numeric', p['durationSeconds'], 184);
    c.eq('billable boolean true', p['billable'], true);
    c.eq('paid boolean true', p['paid'], true);
    c.eq('converted boolean true', p['converted'], true);
    c.eq('completed boolean true', p['completed'], true);
    c.eq('noRoute boolean false', p['noRoute'], false);
    c.eq('revenue numeric', p['revenue'], 28.5);
    c.eq('payout numeric', p['payout'], 19);
    c.eq('cost numeric', p['cost'], 1.1);
    c.eq('telco mirrors cost', p['telco'], 1.1);
    c.ok('endedBy preserved', p['endedBy'] === 'buyer');
    c.ok(
          'occurredAt derived from occurredAtUnix (2025-01-01)',
          (ev?.occurredAt.toISOString() ?? '').startsWith('2025-01-01'),
        );
    c.eq('qualified true (billable+paid+converted)', p['qualified'], true);
    return finalize('canonical webhook body parses into every canonical key', c);
}

async function verifyUnknownStatusAndMissingFieldsAreHonest(): Promise<ScenarioResult> {
    const c = new Checker();
    const events = await provider.parseWebhook(CTX, MINIMAL_UNKNOWN_BODY);
    const ev = events[0];
    const p = (ev?.payload ?? {}) as Record<string, unknown>;
    c.eq(
          'rawEventType is the literal unrecognized status, not fabricated',
          ev?.rawEventType,
          'SOMETHING_NEW_CALLGRID_ADDED',
        );
    c.ok('revenue is absent, not fabricated to 0', p['revenue'] === undefined);
    c.ok('payout is absent, not fabricated to 0', p['payout'] === undefined);
    c.ok('cost is absent, not fabricated to 0', p['cost'] === undefined);
    c.ok('billable is absent, not fabricated to false', p['billable'] === undefined);
    c.ok('completed is absent, not fabricated to true/false', p['completed'] === undefined);
    c.ok('qualified is absent (no signal to derive it from)', p['qualified'] === undefined);
    return finalize('unrecognized status + missing fields stay honest, never fabricated', c);
}

async function verifyLegacyBodyStillWorks(): Promise<ScenarioResult> {
    const c = new Checker();
    const events = await provider.parseWebhook(CTX, LEGACY_TEST_BODY);
    const ev = events[0];
    const p = (ev?.payload ?? {}) as Record<string, unknown>;
    c.eq('externalId read from legacy call_id', ev?.externalId, 'legacy_1');
    c.eq('rawEventType read from legacy status', ev?.rawEventType, 'completed');
    c.eq('caller read from legacy from', p['caller'], '+15559990000');
    c.eq('vendor read from legacy vendor', p['vendor'], 'Legacy Vendor');
    c.eq('durationSeconds parsed from legacy duration', p['durationSeconds'], 42);
    c.eq('billable parsed from legacy yes/no', p['billable'], true);
    c.eq('revenue parsed from legacy revenue', p['revenue'], 10);
    c.eq('payout parsed from legacy payout', p['payout'], 5);
    return finalize('legacy/older test payload keeps working (backward compatible)', c);
}

/** Run every verification scenario and return a structured report. Pure and
 * deterministic: no I/O, no RNG, and the one timestamp fixture is pinned. */
export async function runCallGridWebhookVerification(): Promise<VerificationReport> {
    const scenarios: ScenarioResult[] = [
          await verifyCanonicalBodyParsesFully(),
          await verifyUnknownStatusAndMissingFieldsAreHonest(),
          await verifyLegacyBodyStillWorks(),
        ];
    const all = scenarios.flatMap((s) => s.checks);
    const failures = all.filter((x) => !x.passed).length;
    return { passed: failures === 0, total: all.length, failures, scenarios };
}
