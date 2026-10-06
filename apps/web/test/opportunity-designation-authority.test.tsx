// The only live Opportunity mutation in the app -- the EMG designation of what a creator sees --
// answers to PD-F-11 (CRM slice 3). The EMG seat admits the EMPLOYEE workspace, which AI_EMPLOYEE
// also resolves to; PD-F-11 hard-denies AI_EMPLOYEE every Opportunity write. So the action must
// check the UPDATE act, and must do it BEFORE anything is written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, '..', 'src', 'creator', 'emg-actions.ts'), 'utf8');

test('designateOpportunityAction checks the PD-F-11 UPDATE act before it writes', () => {
  const start = source.indexOf('export async function designateOpportunityAction');
  assert.ok(start >= 0, 'the action exists');
  const body = source.slice(start, source.indexOf('\nexport ', start + 1));
  const check = body.indexOf("permits(actor, 'UPDATE')");
  const write = body.indexOf('.designateOpportunity(');
  assert.ok(check > 0, 'the act table is consulted, not the workspace alone');
  assert.ok(write > check, 'the check comes before the write');
  assert.match(body.slice(check, check + 120), /refuse\(back, 'NOT_ALLOWED'\)/, 'a refusal redirects; nothing is written');
});
