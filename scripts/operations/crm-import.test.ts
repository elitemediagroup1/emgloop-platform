// The CRM outreach import operator command (CRM slice 5, PR A): argument parsing, the target guard
// (production refused by name, local only), the APPLY confirmation, where review artifacts may be
// written, and what each artifact may contain. The synthetic sample fixtures parse and validate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCrmImportCsv, validateCrmImportConfig } from '@emgloop/shared';

import { applyConfirmation, checkTarget, missingFlags, parseArgs, reviewDirAllowed, reviewRows, toCsv, PROTECTED_EXTRA_COLUMNS, REVIEW_COLUMNS } from './crm-import';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

test('arguments: a known command and its required flags, or a precondition failure', () => {
  assert.deepEqual(parseArgs(['dry-run', '--source', 'a.csv', '--replace']), { command: 'dry-run', flags: { source: 'a.csv', replace: true } });
  assert.equal(parseArgs(['import-everything']).command, null);
  assert.deepEqual(missingFlags(parseArgs(['dry-run', '--source', 'a.csv'])), ['config', 'organization', 'actor-user-id|actor-email', 'review-dir']);
  assert.deepEqual(missingFlags(parseArgs(['dry-run', '--source', 'a.csv', '--config', 'c', '--organization', 'o', '--actor-user-id', 'u1', '--review-dir', '/tmp/r'])), [], 'an actor by user id (the workflow never passes an email)');
  assert.deepEqual(missingFlags(parseArgs(['apply', '--source', 'a', '--config', 'c', '--approval-id', 'x', '--expected-sha256', 'h', '--organization', 'o', '--actor-email', 'e'])), ['confirm']);
  assert.deepEqual(missingFlags(parseArgs(['inventory', '--source', 'a.csv'])), ['review-dir']);
  assert.deepEqual(missingFlags(parseArgs([])), ['command']);
});

test('target: local for everything on this machine; production refuses import execution by name', () => {
  const local = 'postgresql://postgres:x@127.0.0.1:55432/loop';
  assert.deepEqual(checkTarget({ LOOP_CRM_IMPORT_TARGET: 'local', DATABASE_URL: local }), { ok: true });
  assert.deepEqual(checkTarget({ LOOP_CRM_IMPORT_TARGET: 'production', DATABASE_URL: local }), { ok: false, reason: 'PRODUCTION_APPLY_NOT_COMMISSIONED' }, 'no command named: refused');
  assert.deepEqual(checkTarget({ LOOP_CRM_IMPORT_TARGET: 'production', DATABASE_URL: local }, 'apply'), { ok: false, reason: 'PRODUCTION_APPLY_NOT_COMMISSIONED' });
  assert.deepEqual(checkTarget({ LOOP_CRM_IMPORT_TARGET: 'production', DATABASE_URL: local }, 'dry-run'), { ok: false, reason: 'PRODUCTION_ONLY_FROM_GITHUB_ACTIONS' }, 'not from a laptop');
  assert.deepEqual(checkTarget({ DATABASE_URL: local }), { ok: false, reason: 'LOOP_CRM_IMPORT_TARGET_MUST_BE_LOCAL_OR_PRODUCTION' });
  assert.deepEqual(checkTarget({ LOOP_CRM_IMPORT_TARGET: 'local', DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/loop' }), { ok: false, reason: 'DATABASE_HOST_NOT_LOCAL' });
  assert.deepEqual(checkTarget({ LOOP_CRM_IMPORT_TARGET: 'local', DATABASE_URL: local, NODE_ENV: 'production' }), { ok: false, reason: 'PRODUCTION_RUNTIME_REFUSED' });
  assert.deepEqual(checkTarget({ LOOP_CRM_IMPORT_TARGET: 'local', DATABASE_URL: 'not a url' }), { ok: false, reason: 'DATABASE_URL_INVALID' });
});

test('the APPLY confirmation names the exact file', () => {
  assert.equal(applyConfirmation('0123456789abcdef0123'), 'apply 0123456789ab');
});

test('review artifacts are refused inside the repository', () => {
  assert.equal(reviewDirAllowed('/workspaces/emgloop-platform/tmp-review', '/workspaces/emgloop-platform'), false);
  assert.equal(reviewDirAllowed('/workspaces/emgloop-platform', '/workspaces/emgloop-platform'), false);
  assert.equal(reviewDirAllowed('/tmp/crm-review', '/workspaces/emgloop-platform'), true);
  assert.equal(reviewDirAllowed('/workspaces/emgloop-platform-review', '/workspaces/emgloop-platform'), true);
});

test('the ordinary review file carries decisions, never an address, number, title, note or source status; the protected one carries them', () => {
  const parsed = parseCrmImportCsv(fixture('crm-import-sample.csv'));
  assert.ok(parsed.ok);
  const plan = {
    rows: parsed.rows.map((r) => ({
      line: r.line,
      sourceRowKey: r.sourceRowKey,
      fingerprint: 'f',
      routeMappingId: null,
      routeClassification: null,
      creatorAliasId: null,
      creatorPartyId: null,
      companyKey: null,
      companyAction: null,
      companyName: null,
      personKey: r.contactNameVerified ? 'k' : null,
      personAction: null,
      contacts: [],
      pursuitKey: null,
      opportunityAction: 'NONE' as const,
      outcome: 'ROUTE_UNMAPPED' as const,
      ambiguityCode: null,
      subjectsApplicable: false,
    })),
    companies: [],
    persons: [],
    pursuits: [],
    counts: {},
  };
  const review = reviewRows({ plan, rows: parsed.rows, invalid: [{ line: 99, sourceRowKey: 'bad', violations: ['X'] }] });
  assert.deepEqual(review.ordinary[0], [...REVIEW_COLUMNS]);
  assert.deepEqual(review.protectedRows[0], [...REVIEW_COLUMNS, ...PROTECTED_EXTRA_COLUMNS]);
  const ordinary = toCsv(review.ordinary);
  for (const s of ['@', '555', 'Partnerships Lead', 'Synthetic note', 'Sample status', 'Example Brand heading']) assert.ok(!ordinary.includes(s), `ordinary review never holds "${s}"`);
  const protectedCsv = toCsv(review.protectedRows);
  for (const s of ['casey@brand.example.test', '+1 555 010 0199', 'Partnerships Lead', 'Synthetic note']) assert.ok(protectedCsv.includes(s), `the protected review holds "${s}" for the reviewer`);
  assert.equal(review.ordinary.at(-1)?.[REVIEW_COLUMNS.indexOf('outcome')], 'INVALID_ROW');
});

test('CSV output neutralizes spreadsheet formulas and quotes what needs quoting', () => {
  assert.equal(toCsv([['=HYPERLINK("x")', 'a,b', 'plain', '+1 555', '@cmd', '-2']]), `"'=HYPERLINK(""x"")","a,b",plain,'+1 555,'@cmd,'-2\r\n`);
});

test('the synthetic sample fixtures are valid against the locked contract, and hold no real data', () => {
  const parsed = parseCrmImportCsv(fixture('crm-import-sample.csv'));
  assert.ok(parsed.ok);
  assert.deepEqual([parsed.rows.length, parsed.invalid.length], [6, 0]);
  for (const r of parsed.rows) {
    for (const v of [r.email, r.phone]) if (v?.includes('@')) assert.match(v, /\.example\.test$/, 'reserved example domains only');
  }
  assert.ok(validateCrmImportConfig(JSON.parse(fixture('crm-import-sample-config.json'))).ok);
});
