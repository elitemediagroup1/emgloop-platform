// Party write actions and read loaders -- identity slice P1.
//
// The actions are the first production callers of PartyService. These tests pin
// the contract the UI track composes: the organization and actor come only from
// the session, a basis is never defaulted, results never echo more than the Party
// id and state, and every loader resolves the session before reading.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PartyWriteResult } from '@emgloop/database';

import { parseCreatePartyForm, parseEstablishPartyForm, toPartyActionResult } from '../src/crm/party-forms';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe('Party form parsing', () => {
  it('create: trims, and an empty name is null; the type is left to PartyService to validate', () => {
    assert.deepEqual(parseCreatePartyForm(form({ partyType: ' PERSON ', displayName: '  Pat  ' })), { partyType: 'PERSON', displayName: 'Pat' });
    assert.deepEqual(parseCreatePartyForm(form({ partyType: 'COMPANY', displayName: '   ' })), { partyType: 'COMPANY', displayName: null });
    assert.deepEqual(parseCreatePartyForm(form({})), { partyType: '', displayName: null });
  });

  it('establish: a missing Party or basis is refused; there is no default basis', () => {
    assert.deepEqual(parseEstablishPartyForm(form({ partyId: 'p1', basis: 'MANUAL' })), { partyId: 'p1', basis: 'MANUAL' });
    assert.equal(parseEstablishPartyForm(form({ partyId: 'p1' })), null);
    assert.equal(parseEstablishPartyForm(form({ basis: 'MANUAL' })), null);
    assert.equal(parseEstablishPartyForm(form({ partyId: ' ', basis: ' ' })), null);
  });

  it('results carry only the outcome, the Party id, its type and whether it is established', () => {
    const party = {
      id: 'p1', organizationId: 'org', partyType: 'PERSON', status: 'KNOWN',
      establishment: { partyTyped: true, established: true, basis: 'MANUAL' }, supersededByIdentityId: null,
    } as const;
    assert.deepEqual(toPartyActionResult({ outcome: 'RECORDED', party } as unknown as PartyWriteResult), {
      outcome: 'RECORDED', partyId: 'p1', partyType: 'PERSON', established: true,
    });
    assert.deepEqual(toPartyActionResult({ outcome: 'NOT_AUTHORIZED' }), { outcome: 'NOT_AUTHORIZED' });
    assert.deepEqual(toPartyActionResult({ outcome: 'NOT_FOUND' }), { outcome: 'NOT_FOUND' });
    assert.deepEqual(toPartyActionResult({ outcome: 'INVALID', reason: 'ARCHIVED' }), { outcome: 'INVALID', reason: 'ARCHIVED' });
  });
});

describe('Party actions and loaders take authority only from the session', () => {
  const actions = code(read('../src/crm/party-actions.ts'));
  const loaders = code(read('../src/crm/party-data.ts'));

  it('every action resolves the session before calling PartyService, and passes its organization, user and name', () => {
    for (const name of ['createPartyAction', 'establishPartyAction']) {
      const start = actions.indexOf(`export async function ${name}(`);
      assert.ok(start >= 0, name);
      const body = actions.slice(start, actions.indexOf('\n}\n', start));
      assert.ok(body.indexOf('requireCrmContext()') >= 0 && body.indexOf('requireCrmContext()') < body.indexOf('parties.'), name);
      assert.match(body, /ctx\.organizationId, ctx\.userId/);
      assert.match(body, /actorName: ctx\.session\.name/);
    }
  });

  it('no organization, actor or role is ever read from the request', () => {
    for (const src of [actions, loaders, code(read('../src/crm/party-forms.ts'))]) {
      assert.doesNotMatch(src, /get\(['"](organizationId|orgId|userId|actorUserId|role|systemRole)['"]\)/);
    }
  });

  it('every loader resolves the session before reading', () => {
    for (const name of ['loadPeople', 'loadCompanies', 'loadEstablishmentQueue', 'loadPartyRecord']) {
      const start = loaders.indexOf(`export async function ${name}(`);
      assert.ok(start >= 0, name);
      const body = loaders.slice(start, loaders.indexOf('\n}\n', start));
      assert.ok(body.indexOf('requireCrmContext()') >= 0 && body.indexOf('requireCrmContext()') < body.indexOf('records.'), name);
    }
    assert.match(loaders, /^import 'server-only';/m);
  });

  it('actions return results and never redirect, so the UI track owns the flow', () => {
    assert.doesNotMatch(actions, /redirect\(/);
    assert.match(read('../src/crm/party-actions.ts'), /^'use server';/);
  });
});
