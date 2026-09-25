// Loop Intelligence (Phases D-E), 2026-09-26: how the web reads domain readings.
//
//   - a personal reading is read with the session's own (organization, user); an organization reading only
//     after the domain's registry read authority is proved from the session (permission AND workspace);
//   - the Home front door and the domain pages read the same stored digest through the same loader;
//   - Mail content: the consent is offered only when the counterparty-consent decision is recorded, stopping
//     is always offered, and both acts require the person's own work-state authority.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

describe('the domain-reading loader', () => {
  const src = code(read('../src/intelligence/domain-reading.ts'));

  it('personal: the session\'s own principal, and nothing from a request', () => {
    assert.match(src, /const principal = \{ organizationId: session\.organizationId, userId: session\.userId \};/);
    assert.match(src, /\.current\(principal, domain, \{ now: opts\.now \}\)/);
    assert.doesNotMatch(src, /searchParams|formData|headers\(/);
  });

  it('organization: the read authority first, then the organization-only read', () => {
    const body = src.slice(src.indexOf('export async function loadOrganizationReading'));
    const guard = body.indexOf('await mayReadOrganizationReading(session, domain)');
    const readAt = body.indexOf('.organizationCurrent(session.organizationId, domain');
    assert.ok(guard > 0 && readAt > guard, 'authority is proved before the read');
    const may = src.slice(src.indexOf('export async function mayReadOrganizationReading'), src.indexOf('export async function loadOrganizationReading'));
    assert.match(may, /entry\.readAuthority\.workspace/);
    assert.match(may, /hasPermission\(resource as never, action as never\)/);
    assert.match(may, /entry\.scopes\.includes\('ORGANIZATION'\)/, 'a private domain is never an organization reading');
  });

  it('Home and the domain pages read through this one loader; nothing reads digests another way for them', () => {
    const front = code(read('../src/app/app/_home/front-door-data.ts'));
    assert.match(front, /loadPrincipalReading\(session, t\.domain/);
    assert.match(front, /loadOrganizationReading\(session, t\.domain/);
    assert.equal(front.includes('IntelligenceDigestRepository'), false);
    const mail = code(read('../src/app/app/mail/page.tsx'));
    assert.match(mail, /loadPrincipalReading\(session, 'MAIL'/);
  });
});

describe('Mail content consent', () => {
  it('offered only under a recorded decision; stopping always offered; both need employeeIntelligence:update', () => {
    const page = code(read('../src/app/app/mail/page.tsx'));
    assert.match(page, /const governance = mailContentGovernance\(process\.env\[MAIL_CONTENT_GOVERNANCE_ENV\]\);/);
    assert.match(page, /\) : governance\.state === 'DECIDED' \? \(\s*<form action=\{authorizeMailContentAction\}/);
    assert.match(page, /contentOn \? \(\s*<form action=\{revokeMailContentAction\}/);
    const actions = code(read('../src/daily-loop/mail-content-actions.ts'));
    assert.equal((actions.match(/requirePermission\('employeeIntelligence', 'update'\)/g) ?? []).length, 2);
    assert.match(actions, /governanceDecision: process\.env\[MAIL_CONTENT_GOVERNANCE_ENV\] \?\? null/);
    assert.doesNotMatch(actions, /form\.get|organizationId: form|userId: form/);
  });
});
