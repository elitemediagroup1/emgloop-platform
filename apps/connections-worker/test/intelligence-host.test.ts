// Loop Intelligence Phase E: the worker's producer host is OFF unless producers are named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createIntelligenceHost, readIntelligenceHostConfig } from '../src/intelligence-host';

test('config: nothing named is nothing scheduled; the interval has a floor', () => {
  assert.deepEqual(readIntelligenceHostConfig({}), { producers: [], situations: [], briefings: false, actingUsersRaw: '', intervalMs: 15 * 60 * 1000 });
  assert.equal(readIntelligenceHostConfig({ LOOP_INTELLIGENCE_BRIEFINGS: 'true' }).briefings, false, 'exactly "on"');
  assert.equal(readIntelligenceHostConfig({ LOOP_INTELLIGENCE_BRIEFINGS: 'on' }).briefings, true);
  assert.deepEqual(readIntelligenceHostConfig({ LOOP_INTELLIGENCE_SITUATIONS: 'private, Organization ,bogus' }).situations, ['ORGANIZATION', 'PRINCIPAL']);
  const c = readIntelligenceHostConfig({ LOOP_INTELLIGENCE_PRODUCERS: ' callgrid.domain@1, ,callgrid.domain@1,work.domain@1', LOOP_INTELLIGENCE_INTERVAL_MS: '1000' });
  assert.deepEqual(c.producers, ['callgrid.domain@1', 'work.domain@1']);
  assert.equal(c.intervalMs, 15 * 60 * 1000, 'below the floor falls back to the default');
});

test('an empty activation list builds an inert host: not scheduled, and its pass touches nothing', async () => {
  const touched: string[] = [];
  const prisma = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); return undefined; } }) as never;
  const host = await createIntelligenceHost(prisma, readIntelligenceHostConfig({}), { runtime: null, activatedTasks: [] }, () => undefined);
  assert.equal(host.scheduled, false);
  await host.pass();
  assert.deepEqual(touched, []);
});

test('the worker schedules the intelligence timer only when the host says so, and clears it on shutdown', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  assert.match(src, /intelligence\.scheduled \? setInterval\(/);
  assert.match(src, /if \(intelligenceTimer\) clearInterval\(intelligenceTimer\)/);
  const host = readFileSync(join(__dirname, '..', 'src', 'intelligence-host.ts'), 'utf8');
  // Counts and codes only in the log line: never an organization or a person.
  const logLine = host.slice(host.indexOf("log('intelligence_pass'"), host.indexOf("log('intelligence_pass'") + 600);
  assert.doesNotMatch(logLine, /organizationId|userId|subjectRef/);
});
