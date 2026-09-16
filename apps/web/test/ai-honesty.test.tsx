// Loop does not claim intelligence it does not have. Fake-AI cleanup, 2026-09-16.
//
// Slice S1 will put real model output on a screen. The day it does, every OTHER
// surface implying intelligence has to be genuinely intelligent or honestly
// labelled -- otherwise a reader has no way to tell which is which, and the real
// one inherits the credibility of the fake ones.
//
// WHAT THESE PROVE
//
// THE FABRICATED METRIC IS GONE. "AI resolution rate" was (1 - sentiment signals /
// conversation-end signals) x 100, presented as an AI performance figure. No AI
// resolves anything here, and with no such signals it read 0% -- a zero dressed as
// data about a capability that does not exist. Product decided to delete it rather
// than rename it, so it does not remain beside real AI later.
//
// NO HEADING CLAIMS AI THAT ITS OWN SUBTITLE DENIES. The Setup Assistant said "AI"
// above the words "no external AI required". A reader believes the heading.
//
// A DERIVED COVERAGE FIGURE IS NOT A PROBABILITY. Nothing renders "N% confidence".
// The Evidence Engine's number measures coverage, sample size, staleness and
// contradictions; shown as a percentage it cannot be told apart from "N% likely to
// be true", and it is exactly the slot a model's self-reported certainty would drop
// into. Surfaces state a strength and its basis instead.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WEB_SRC = join(__dirname, '..', 'src');
const REPO = join(__dirname, '..', '..', '..');

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', '.next', 'dist'].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Source with its prose removed: a comment explaining what was deleted is not a claim. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

describe('the fabricated AI metric is gone', () => {
  it('no surface renders an "AI resolution rate"', () => {
    for (const file of sourceFiles(WEB_SRC)) {
      assert.doesNotMatch(code(file), /AI resolution rate/i, file.slice(REPO.length));
    }
  });

  it('no repository computes or exposes one', () => {
    const analytics = code(join(REPO, 'packages/database/src/repositories/analytics.repository.ts'));
    assert.doesNotMatch(analytics, /resolutionRate|aiResolutionRate/);
    // The counts it was derived from stay: they are real signal counts, and they are
    // not presented as an AI metric.
    assert.match(analytics, /aiConversationsStarted/);
  });
});

describe('no heading claims an AI that does not exist', () => {
  it('the Setup Assistant is not called an AI assistant', () => {
    for (const file of sourceFiles(WEB_SRC)) {
      assert.doesNotMatch(code(file), /AI Setup Assistant/, file.slice(REPO.length));
    }
    const page = readFileSync(join(WEB_SRC, 'app/crm/integrations/assistant/page.tsx'), 'utf8');
    assert.match(page, /<h1 className="crm-h1">Setup Assistant<\/h1>/);
    // And it still tells the reader what it is.
    assert.match(page, /no external AI/i);
  });
});

describe('a derived coverage figure is never rendered as a certainty', () => {
  it('nothing renders a percentage confidence', () => {
    for (const file of sourceFiles(WEB_SRC)) {
      const src = code(file);
      assert.doesNotMatch(src, /%\s*confidence/i, file.slice(REPO.length));
      assert.doesNotMatch(src, /confidence\s*\*\s*100|confidencePct/i, file.slice(REPO.length));
    }
  });

  it('the surfaces that used to state a strength instead', () => {
    const intelligence = readFileSync(join(WEB_SRC, 'app/app/admin/marketplace/intelligence-ui.tsx'), 'utf8');
    assert.match(intelligence, /EVIDENCE_STRENGTH_LABEL\[evidenceStrengthOf\(finding\)\]/);
    const home = readFileSync(join(WEB_SRC, 'app/app/admin/home-data.ts'), 'utf8');
    assert.match(home, /evidenceStrengthFromDerivedConfidence/);
    assert.match(home, /evidenceLabel/);
  });

  it('one threshold table decides what a strength means', () => {
    const shared = readFileSync(join(REPO, 'packages/shared/src/callgrid-decision-support.ts'), 'utf8');
    const thresholds = [...shared.matchAll(/confidence >= 0\.8/g)];
    assert.equal(thresholds.length, 1, 'the HIGH threshold exists in exactly one place');
    assert.match(shared, /export function evidenceStrengthFromDerivedConfidence/);
  });
});
