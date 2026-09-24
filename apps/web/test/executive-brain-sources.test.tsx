// The Executive Brain says accurately what it reads (2026-09-24).
//
// It used to declare Gmail, Calendar and "AI Conversations" uninstrumented with claims that had
// stopped being true: "No inbound email ingestion exists", "Only a mock calendar provider exists",
// "There is no LLM in the platform". Gmail and Calendar sync exist (each employee's own connection,
// synced for that person only), and a governed AI runtime exists. The accurate statement is
// different in kind: those sources EXIST, and the Executive Brain deliberately does not read them
// -- it reads organization-scoped sources only (employee-private sources are never rolled up), and
// it calls no model. These tests hold the declarations, the loader and the rendered board to that.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  EXECUTIVE_EXCLUDED_SENSORS,
  EXECUTIVE_UNINSTRUMENTED_SENSORS,
  buildDomainSensor,
  runExecutiveBrain,
} from '@emgloop/intelligence';
import { ExecutiveBrainView } from '../src/app/app/admin/_executive/ExecutiveBrainView';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const INTELLIGENCE = join(REPO, 'packages/intelligence');
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full, ext));
    else if (ext.test(name)) out.push(full);
  }
  return out;
}

/** Claims that were true once and are false now. None may remain in any product string or package doc. */
const STALE = [
  /No inbound email ingestion exists/i,
  /Only a mock calendar provider exists/i,
  /There is no LLM in the platform/i,
  /no LLM in the platform/i,
  /AI Employees are configuration, not reasoning/i,
  /no AI conversation content is produced/i,
  /There is no Opportunity model/i,
  /The Creator workspace is a shell stub/i,
];

describe('no stale claim about Gmail, Calendar or the AI runtime remains', () => {
  it('scans the web app and the intelligence package, code and docs', () => {
    const scanned = [...files(SRC, /\.(ts|tsx)$/), ...files(INTELLIGENCE, /\.(ts|tsx|md)$/)];
    assert.ok(scanned.length > 50);
    for (const file of scanned) {
      const text = readFileSync(file, 'utf8');
      for (const claim of STALE) assert.doesNotMatch(text, claim, `${relative(REPO, file)}: ${claim}`);
    }
  });
});

describe('the declarations are accurate', () => {
  const excluded = new Map(EXECUTIVE_EXCLUDED_SENSORS.map((s) => [s.id, s]));

  it('Gmail, Calendar and the AI runtime are EXCLUDED -- sources that exist and are deliberately not read -- never "missing"', () => {
    assert.deepEqual([...excluded.keys()].sort(), ['ai-runtime', 'calendar', 'gmail']);
    for (const s of EXECUTIVE_EXCLUDED_SENSORS) {
      assert.equal(s.instrumented, false);
      assert.ok(s.excluded.exists.length > 0 && s.excluded.reason.length > 0, s.id);
    }
    for (const id of ['gmail', 'calendar', 'ai-runtime']) {
      assert.equal(EXECUTIVE_UNINSTRUMENTED_SENSORS.some((s) => s.id === id), false, `${id} is not "not built"`);
    }
    assert.match(excluded.get('gmail')!.excluded.exists, /connect their own Gmail/);
    assert.match(excluded.get('gmail')!.excluded.reason, /employee-private[\s\S]*organization-scoped sources only/i);
    assert.match(excluded.get('calendar')!.excluded.exists, /connect their own Google Calendar/);
    assert.match(excluded.get('calendar')!.excluded.reason, /employee-private[\s\S]*organization-scoped sources only/i);
    const ai = excluded.get('ai-runtime')!.excluded;
    assert.match(ai.exists, /governed AI runtime/);
    assert.match(ai.exists, /Telegram content triage runs in the connections worker under each employee’s own consent/);
    assert.match(ai.exists, /mail reply drafts and Case explanations are produced only when someone asks/);
    assert.match(ai.exists, /set per environment/);
    assert.match(ai.reason, /The Executive Brain itself calls no model\./);
  });

  it('no declaration claims the Brain reads a private source or calls a model', () => {
    const texts = [
      ...EXECUTIVE_EXCLUDED_SENSORS.flatMap((s) => [s.excluded.exists, s.excluded.reason]),
      ...EXECUTIVE_UNINSTRUMENTED_SENSORS.flatMap((s) => [s.uninstrumented.reason, s.uninstrumented.unblockedBy ?? '']),
    ];
    for (const t of texts) {
      assert.doesNotMatch(t, /Brain (reads|rolls up|reviews|sees|summari[sz]es) (the |each |every |an? )?(employee|mail|inbox|calendar|Telegram|chat)/i, t);
      assert.doesNotMatch(t, /Brain (calls|uses|asks|runs) (a|an|the) (model|LLM|AI)/i, t);
      assert.doesNotMatch(t, /there is no (LLM|model|AI)/i, t);
    }
  });

  it('the loader hands the Brain the declarations and reads no employee-private source and no model', () => {
    const loader = code(readFileSync(join(SRC, 'app/app/admin/_executive/executive-brain-data.ts'), 'utf8'));
    assert.match(loader, /\.\.\.EXECUTIVE_EXCLUDED_SENSORS, \.\.\.EXECUTIVE_UNINSTRUMENTED_SENSORS\]/);
    for (const privateOrModel of ['mail', 'Mail', 'calendar', 'Calendar', 'telegram', 'Telegram', 'google', 'Google', 'sourceObservation', 'AiRuntime', 'aiRuntime', 'Gateway', 'provider.', '@emgloop/providers', 'needsYou']) {
      assert.equal(loader.includes(privateOrModel), false, privateOrModel);
    }
    const pkg = files(join(INTELLIGENCE, 'src'), /\.ts$/).map((f) => code(readFileSync(f, 'utf8'))).join('\n');
    for (const io of ['@emgloop/providers', '@emgloop/database', 'fetch(', 'process.env', '@anthropic-ai', "from 'openai'"]) assert.equal(pkg.includes(io), false, io);
  });
});

describe('the Evidence Coverage board says it', () => {
  it('excluded sources render as "Not read by design" with what exists and why; they are not gaps', () => {
    const crm = buildDomainSensor({
      id: 'crm', label: 'CRM', domain: 'crm', scopeLabel: 'last 7 days', populationSize: 10, staleAfterMs: null,
      emptyScopeReason: 'x', measuredAt: '2026-09-24T12:00:00.000Z',
      metrics: [{ metricId: 'crm.conversations', label: 'Conversations opened', observed: 4, total: null, provenance: [{ sourceId: 'crm', sourceLabel: 'crm', derivation: 'count', citation: null }] }],
    });
    const report = runExecutiveBrain([crm, ...EXECUTIVE_EXCLUDED_SENSORS, ...EXECUTIVE_UNINSTRUMENTED_SENSORS], new Date('2026-09-24T12:00:00.000Z'));
    const status = new Map(report.evidenceCoverage.sensors.map((s) => [s.sensorId, s.status]));
    for (const id of ['gmail', 'calendar', 'ai-runtime']) assert.equal(status.get(id), 'excluded', id);
    assert.equal(report.evidenceCoverage.statusCounts.excluded, 3);
    assert.equal(report.evidenceCoverage.statusCounts.missing, EXECUTIVE_UNINSTRUMENTED_SENSORS.length);
    assert.match(report.systemHealth.caveat ?? '', new RegExp(`^${EXECUTIVE_UNINSTRUMENTED_SENSORS.length} sensor\\(s\\) are not yet instrumented`), 'only the unwired count as gaps');
    const html = renderToStaticMarkup(<ExecutiveBrainView report={report} />);
    assert.match(html, /reads organization-scoped\s+sources only and calls no AI model/);
    assert.match(html, /3 not read by design/);
    assert.match(html, /1 of 5 sensors instrumented/, 'excluded sources are not counted as sensors to instrument');
    assert.match(html, /1 of 5 sensors wired\. 3 source\(s\) deliberately not read\./);
    assert.match(html, /Gmail[\s\S]*?Not read by design[\s\S]*?What exists[\s\S]*?Why the Brain does not read it/);
    assert.equal(/Gmail[^<]*<\/span><span[^>]*>Missing/.test(html), false, 'Gmail is never "Missing"');
  });
});
