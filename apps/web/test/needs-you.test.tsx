// The "Needs you" Home element (content-triage): renders the real component with prepared items and
// checks the markup. It proves the surface is source-labelled, minimized, USEFUL and employee-private in
// shape: a Telegram-tagged NEEDS_YOU row says who it is with (the source's own label), what happened (the
// AI's paraphrase), what to do next and any deadline the conversation named; it points back to the
// source; it carries no message body; and it invents nothing for a field the source did not supply. With
// nothing to show, it renders nothing (Home stays quiet, not empty).

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
  title: 'Dana Reyes asks to reschedule the Thursday kickoff call',
  category: 'REQUEST',
  counterparty: 'Dana Reyes',
  topic: 'Kickoff call',
  nextStep: 'Propose a new time',
  deadline: 'by Thursday',
  at: new Date('2026-09-21T15:30:00Z'),
  detectionCount: 1,
  ...over,
});

test('a Telegram NEEDS_YOU item renders WHO, WHAT, what to DO and WHEN -- source-labelled and minimized', () => {
  const html = renderToStaticMarkup(<NeedsYou items={[item()]} time={time} />);
  assert.ok(html.includes('Needs you'), 'the panel is titled');
  assert.ok(html.includes('Telegram'), 'the source is labelled');
  assert.ok(html.includes('data-needs-you-provider="TELEGRAM"'), 'the row carries its provider');
  assert.match(html, /data-needs-you-about[^>]*>Dana Reyes · Kickoff call</, 'WHO it is with and what it is about');
  assert.ok(html.includes('Dana Reyes asks to reschedule the Thursday kickoff call'), 'WHAT happened, as the minimized paraphrase');
  assert.match(html, /data-needs-you-next[^>]*>Next: Propose a new time</, 'what the person must DO');
  assert.match(html, /data-needs-you-deadline[^>]*>Due by Thursday</, 'the deadline the conversation named');
  assert.ok(html.includes('Request'), 'the category is shown in plain words');
  assert.ok(html.includes('still open as of'), 'it says the item was still unresolved at the last review');
  // Return-to-source, honest: it points back to the app, and never claims a link a private chat lacks.
  assert.ok(html.includes('Open the conversation'), 'it points back to the source');
  assert.ok(!html.includes('href'), 'no fabricated deep link for a private chat');
});

test('a field the source did not supply is simply absent -- no invented name, topic, next step or deadline', () => {
  const html = renderToStaticMarkup(<NeedsYou items={[item({ counterparty: null, topic: null, nextStep: null, deadline: null })]} time={time} />);
  assert.ok(html.includes('Dana Reyes asks to reschedule the Thursday kickoff call'), 'the paraphrase still shows');
  assert.ok(!html.includes('data-needs-you-about'), 'no who/topic line');
  assert.ok(!html.includes('data-needs-you-next'), 'no next-step line');
  assert.ok(!html.includes('data-needs-you-deadline'), 'no deadline pill');
  assert.ok(!html.includes('Due '), 'no "Due" without a deadline');
  assert.ok(!/\bnull\b|\bundefined\b/.test(html), 'nothing renders as null/undefined');
  // A topic without a label is fine on its own, and vice versa.
  const topicOnly = renderToStaticMarkup(<NeedsYou items={[item({ counterparty: null })]} time={time} />);
  assert.match(topicOnly, /data-needs-you-about[^>]*>Kickoff call</);
});

test('with nothing to show, the element renders nothing', () => {
  assert.equal(renderToStaticMarkup(<NeedsYou items={[]} time={time} />), '');
});

test('the element and its loader are server-first: no client boundary', () => {
  assert.ok(!read('../src/app/app/_home/needs-you.tsx').includes("'use client'"), 'the element is a server component');
  assert.ok(!read('../src/daily-loop/needs-you.ts').includes("'use client'"), 'the loader is server-only');
});
