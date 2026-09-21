// The "Needs you" Home element (content-triage): renders the real component with prepared items and
// checks the markup. It proves the surface is source-labelled, minimized, and employee-private in shape:
// a Telegram-tagged NEEDS_YOU row shows the AI's paraphrase and its category, points back to the source,
// and carries no message body. With nothing to show, it renders nothing (Home stays quiet, not empty).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { createTimeView } from '@emgloop/shared';

import { NeedsYou } from '../src/app/app/_home/needs-you';
import type { NeedsYouItem } from '../src/daily-loop/needs-you';

const NY = { timeZone: 'America/New_York', source: 'device' as const };
const NOW = new Date('2026-09-21T16:00:00Z');
const time = createTimeView(NY, NOW);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const item = (over: Partial<NeedsYouItem> = {}): NeedsYouItem => ({
  id: 'w1',
  provider: 'TELEGRAM',
  sourceLabel: 'Telegram',
  title: 'Client asks to reschedule the Thursday call',
  category: 'REQUEST',
  at: new Date('2026-09-21T15:30:00Z'),
  detectionCount: 1,
  ...over,
});

test('a Telegram NEEDS_YOU item renders source-labelled, with its category and paraphrase', () => {
  const html = renderToStaticMarkup(<NeedsYou items={[item()]} time={time} />);
  assert.ok(html.includes('Needs you'), 'the panel is titled');
  assert.ok(html.includes('Telegram'), 'the source is labelled');
  assert.ok(html.includes('data-needs-you-provider="TELEGRAM"'), 'the row carries its provider');
  assert.ok(html.includes('Client asks to reschedule the Thursday call'), 'the minimized paraphrase is shown');
  assert.ok(html.includes('Request'), 'the category is shown in plain words');
  // Return-to-source, honest: it points back to the app, and never claims a link a private chat lacks.
  assert.ok(html.includes('Open the conversation'), 'it points back to the source');
  assert.ok(!html.includes('href'), 'no fabricated deep link for a private chat');
});

test('with nothing to show, the element renders nothing', () => {
  assert.equal(renderToStaticMarkup(<NeedsYou items={[]} time={time} />), '');
});

test('the element and its loader are server-first: no client boundary', () => {
  assert.ok(!read('../src/app/app/_home/needs-you.tsx').includes("'use client'"), 'the element is a server component');
  assert.ok(!read('../src/daily-loop/needs-you.ts').includes("'use client'"), 'the loader is server-only');
});
