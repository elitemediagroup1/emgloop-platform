// Structural tests for Phase 1 PR D — CRM UX, accessibility and responsive pass.
//
// Source-level assertions, the same pattern as crm-authority.test.tsx: the dev
// environment has no database or browser, so these pin the properties a
// regression would most plausibly remove — semantics, labels, landmarks,
// honest failure states, and the contrast of the shared text token.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActorDisplay, Timeline, TimelineItem, fromInboxItem } from '../src/crm/timeline';
import { SectionTabs } from '../src/crm/section-tabs';
import { CrmLoadError } from '../src/crm/load-error';
import { LOOP_NAV } from '../src/workspaces/config';

const render = (el: unknown) => renderToStaticMarkup(el as never);

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const SHELL = read('../src/workspaces/WorkspaceShell.tsx');
const SHELL_NAV = read('../src/workspaces/ShellNav.tsx');
const TABS = read('../src/crm/section-tabs.tsx');
const LOAD_ERROR = read('../src/crm/load-error.tsx');
const TIMELINE = read('../src/crm/timeline.tsx');
const COMMAND = read('../src/app/crm/page.tsx');
const SEARCH = read('../src/app/crm/search/page.tsx');
const CUSTOMER = read('../src/app/crm/customers/[id]/page.tsx');
const ORG = read('../src/app/crm/organizations/[id]/page.tsx');
const PIPELINE = read('../src/app/crm/pipeline/page.tsx');
const PEOPLE = read('../src/app/crm/customers/page.tsx');
const DS_CSS = read('../src/app/crm/design-system.css');
const CRM_CSS = read('../src/app/crm/crm.css');
const SHELL_CSS = read('../src/app/loop-os.css');

// The CRM area of the one Loop navigation registry.
function navItems(): { href: string; label: string; soon: boolean }[] {
  const crm = LOOP_NAV.nav.find((g) => g.label === 'CRM');
  assert.ok(crm, 'LOOP_NAV has a CRM area');
  return crm!.items.map((i) => ({ href: i.href, label: i.label, soon: Boolean(i.soon) }));
}

describe('Shell and navigation', () => {
  it('offers a skip link to a focusable main region', () => {
    assert.match(SHELL, /className="loop-skip" href="#loop-main"/);
    assert.match(SHELL, /<main className="loop-main" id="loop-main" tabIndex=\{-1\}>/);
    assert.match(SHELL_CSS, /\.loop-skip:focus \{/);
  });

  it('exposes sidebar and breadcrumb as named navigation landmarks', () => {
    assert.match(SHELL_NAV, /<nav className="loop-sb__scroll" aria-label=\{label\}>/);
    assert.match(SHELL, /<nav className="loop-crumbs" aria-label="Breadcrumb">/);
    assert.match(SHELL_NAV, /aria-current=\{isActive \? 'page' : undefined\}/);
  });

  it('never labels the Customer.status intake board as Pipeline or Opportunities', () => {
    const intake = navItems().find((i) => i.href === '/crm/pipeline');
    assert.ok(intake, '/crm/pipeline is in the CRM nav');
    assert.equal(intake!.label, 'Intake Board');
    assert.equal(navItems().some((i) => /pipeline/i.test(i.label)), false);
    const opportunities = navItems().find((i) => i.label === 'Opportunities');
    assert.ok(opportunities?.soon, 'Opportunities is an unbuilt Phase 2 domain');
    assert.notEqual(opportunities!.href, '/crm/pipeline');
  });

  it('every enabled CRM nav item resolves to a real route; unbuilt ones are marked soon', () => {
    for (const item of navItems()) {
      const page = new URL(`../src/app${item.href}/page.tsx`, import.meta.url);
      if (item.soon) {
        assert.equal(existsSync(page), false, `${item.href} is marked soon but a route exists — enable it`);
      } else {
        assert.ok(existsSync(page), `${item.href} (${item.label}) has no page.tsx`);
      }
    }
  });

  it('collapses the sidebar into a scrollable strip on small screens', () => {
    const phone = SHELL_CSS.slice(SHELL_CSS.lastIndexOf('@media (max-width: 820px)'));
    assert.match(phone, /\.loop-sb__scroll \{[^}]*overflow-x: auto/);
    assert.match(phone, /\.loop-main \{ padding: 20px 16px/);
  });

  it('nav destinations carry the same names as their nav items', () => {
    assert.match(code(PIPELINE), /<h1 className="crm-h1">Intake Board<\/h1>/);
    assert.equal(/<h1[^>]*>Pipeline</.test(PIPELINE), false);
    assert.equal(/<h1[^>]*>Customers</.test(PEOPLE), false);
    assert.match(CUSTOMER, /<span aria-hidden="true">←<\/span> People/);
  });
});

describe('Section tabs', () => {
  it('are navigation with aria-current, not an ARIA tablist without keyboard support', () => {
    assert.match(TABS, /<nav className="crm-section-tabs" aria-label=\{label\}>/);
    assert.match(TABS, /aria-current=\{t\.active \? 'page' : undefined\}/);
    assert.equal(/role="tab/.test(code(TABS)), false);
  });

  it('render an unbuilt section as a labelled non-link, never a link to nothing', () => {
    const soonBranch = TABS.slice(TABS.indexOf('t.soon ?'), TABS.indexOf(') : ('));
    assert.match(soonBranch, /<span className="crm-section-tab is-disabled" aria-disabled="true">/);
    assert.equal(soonBranch.includes('<Link'), false);
    assert.match(soonBranch, /Soon/);
  });

  it('are the only tab implementation on both record pages', () => {
    for (const [name, src] of [['customer', CUSTOMER], ['organization', ORG]] as const) {
      assert.match(src, /<SectionTabs/, `${name} uses SectionTabs`);
      assert.equal(/role="tab/.test(src), false, `${name} has no role=tab/tablist`);
      assert.equal(/crm-tabs|org-tabs|org-tab\b/.test(src), false, `${name} has no legacy tab classes`);
    }
    assert.equal(/\.org-tabs|\.org-tab\b|\.crm-tabs/.test(DS_CSS + CRM_CSS), false, 'retired tab CSS is gone');
  });

  it('keep the organization Opportunities/Relationships/Campaigns sections disabled', () => {
    for (const label of ['Relationships', 'Opportunities', 'Campaigns']) {
      assert.match(ORG, new RegExp(`label: '${label}', href: base, soon: true`), label);
    }
  });
});

describe('Timeline primitives', () => {
  it('attribute inbox activity to its actor, not to the person it concerns', () => {
    const fn = TIMELINE.slice(TIMELINE.indexOf('export function fromInboxItem'), TIMELINE.indexOf('export function fromAuditView'));
    assert.equal(/actor:\s*item\.customerName/.test(fn), false);
    assert.match(fn, /actor:\s*ACTOR_TYPE_LABELS\[item\.actorType\]/);
  });

  it('hide the decorative badge and keep list semantics', () => {
    const badge = TIMELINE.slice(TIMELINE.indexOf('export function ActivityTypeBadge'), TIMELINE.indexOf('export function ActorDisplay'));
    assert.equal(badge.includes('aria-label'), false);
    assert.equal((badge.match(/aria-hidden="true"/g) ?? []).length, 2);
    assert.match(TIMELINE, /<ul className="tl" role="list">/);
  });

  it('do not repeat an actor type that equals the actor name', () => {
    const actor = TIMELINE.slice(TIMELINE.indexOf('export function ActorDisplay'), TIMELINE.indexOf('export function ProvenanceDisplay'));
    assert.match(actor, /typeLabel\.toLowerCase\(\) !== shown\.toLowerCase\(\)/);
  });

  it('wrap long titles and bodies instead of truncating them', () => {
    const tl = DS_CSS.slice(DS_CSS.indexOf('Timeline primitives'));
    const title = tl.match(/\.tl-title \{[^}]*\}/)?.[0] ?? '';
    const body = tl.match(/\.tl-body \{[^}]*\}/)?.[0] ?? '';
    assert.equal(/nowrap|ellipsis/.test(title + body), false);
    assert.match(body, /overflow-wrap: anywhere/);
  });
});

describe('Honest failure states', () => {
  const surfaces = [['Command Center', COMMAND], ['search', SEARCH], ['customer', CUSTOMER], ['organization', ORG]] as const;

  it('each Phase 1 surface renders CrmLoadError when its read fails', () => {
    for (const [name, src] of surfaces) {
      assert.match(src, /loadOrFallback\(/, `${name} loads through loadOrFallback`);
      assert.match(src, /<CrmLoadError failure=\{/, `${name} renders CrmLoadError`);
      assert.equal(src.includes('DbNotConfigured'), false, `${name} no longer renders the legacy full-page notice`);
    }
  });

  it('authorization and tenancy checks run before, not inside, the swallowing loader', () => {
    for (const [name, src] of surfaces) {
      const loader = src.indexOf('loadOrFallback(');
      assert.ok(src.indexOf('requireCrmContext(') < loader, `${name}: context resolved first`);
    }
    assert.ok(ORG.indexOf('params.id !== ctx.organizationId') < ORG.indexOf('loadOrFallback('));
    assert.ok(ORG.indexOf("requirePermission('organizations', 'view')") < ORG.indexOf('loadOrFallback('));
    assert.ok(SEARCH.indexOf("requirePermission('customers', 'view')") < SEARCH.indexOf('loadOrFallback('));
    assert.ok(CUSTOMER.indexOf("requirePermission('customers', 'view')") < CUSTOMER.indexOf('loadOrFallback('));
  });

  it('never shows the raw database error to the operator', () => {
    assert.equal(/failure\.message/.test(LOAD_ERROR), false);
    assert.match(LOAD_ERROR, /role="alert"/);
  });
});

describe('Semantics and labels on Phase 1 surfaces', () => {
  it('headings do not skip from h1 to h3', () => {
    for (const [name, src] of [['Command Center', COMMAND], ['customer', CUSTOMER], ['organization', ORG]] as const) {
      assert.equal(/<h3[\s>]/.test(src), false, `${name} has no h3`);
      assert.match(src, /<h2[\s>]/, `${name} uses h2 section headings`);
    }
    assert.match(DS_CSS, /\.ds-card-head :is\(h2, h3\)/);
    assert.match(DS_CSS, /\.crm-ws \.crm-card > h2/);
  });

  it('customer intake is never presented as a pipeline on the record page', () => {
    assert.equal(/Pipeline status/.test(CUSTOMER), false);
    assert.match(CUSTOMER, /<h2>Intake status<\/h2>/);
    assert.match(CUSTOMER, /name="status"[^>]*aria-label="Intake status"/);
  });

  it('every customer record form control has an accessible name', () => {
    assert.match(CUSTOMER, /htmlFor="assign-human"/);
    assert.match(CUSTOMER, /id="assign-human"/);
    assert.match(CUSTOMER, /htmlFor="assign-ai"/);
    assert.match(CUSTOMER, /id="assign-ai"/);
    assert.match(CUSTOMER, /name="tag"[^>]*aria-label="Add tag"/);
    assert.match(CUSTOMER, /aria-label=\{`Remove tag \$\{t\}`\}/);
    assert.match(CUSTOMER, /name="body"[^>]*aria-label="Internal note"/);
  });

  it('record-page copy does not attribute recorded data to the Brain or a vendor', () => {
    const jsx = code(CUSTOMER);
    assert.equal(/the Brain/.test(jsx), false);
    assert.equal(/Neon/.test(jsx), false);
  });

  it('decorative arrows and glyphs are hidden from assistive technology', () => {
    for (const [name, src] of [['Command Center', COMMAND], ['organization', ORG]] as const) {
      assert.equal(/→<\/Link>/.test(src), false, `${name}: no bare arrow in a link name`);
    }
    assert.equal((COMMAND.match(/className="cc-action__ico" aria-hidden="true"/g) ?? []).length, 4);
    assert.match(ORG, /aria-label=\{`View \$\{c\.name \|\| 'unnamed person'\}`\}/);
  });

  it('search keeps focus off the input once results are showing, and lists results', () => {
    assert.match(SEARCH, /autoFocus=\{!q\}/);
    assert.match(SEARCH, /<ul className="search-group__list" role="list">/);
    assert.equal(SEARCH.includes('crm-btn-primary'), false, 'the full-width login button class is not used');
  });

  it('greets the operator in the organization timezone, not the server clock', () => {
    assert.equal(/getHours\(\)/.test(COMMAND), false);
    assert.match(COMMAND, /orgClock\(org\?\.timezone\)/);
    assert.match(COMMAND, /timeZone: zone/);
  });
});

describe('Design tokens', () => {
  function token(name: string): string {
    const m = DS_CSS.match(new RegExp(`--crm-${name}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(m, `--crm-${name} is a hex token`);
    return m![1]!;
  }
  function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  }
  function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  }

  it('--crm-faint and --crm-muted meet WCAG AA (4.5:1) on every CRM surface', () => {
    for (const fg of ['faint', 'muted']) {
      for (const bg of ['bg', 'panel', 'card', 'hover']) {
        const ratio = contrast(token(fg), token(bg));
        assert.ok(ratio >= 4.5, `--crm-${fg} on --crm-${bg} is ${ratio.toFixed(2)}:1`);
      }
    }
  });

  it('removes the doubled gutter inside the shared shell', () => {
    assert.match(DS_CSS, /\.crm--embedded \.crm-page \{ padding: 0; \}/);
  });
});

describe('Rendered output', () => {
  const inbox = {
    id: 'i1', customerName: 'Dana Reyes', kind: 'SMS', channel: 'SMS', direction: 'outbound',
    summary: 'Confirmed the appointment for Tuesday', actorType: 'AI_AGENT', occurredAt: new Date().toISOString(),
  };

  it('an AI-sent message about a person is attributed to AI, with the person as the subject', () => {
    const entry = fromInboxItem(inbox);
    assert.equal(entry.title, 'Dana Reyes');
    assert.equal(entry.actor, 'AI');
    const html = render(<Timeline><TimelineItem entry={entry} /></Timeline>);
    assert.match(html, /<ul class="tl" role="list">/);
    assert.match(html, /<span class="tl-badge tl-badge--out" aria-hidden="true"><\/span>/);
    assert.equal(/aria-label/.test(html), false);
    assert.match(html, /Interaction/, 'provenance is still stated in text');
  });

  it('an actor type identical to the actor name is not repeated', () => {
    assert.equal(render(<ActorDisplay name="System" type="SYSTEM" />).includes('tl-actor__type'), false);
    assert.match(render(<ActorDisplay name="website" type="SYSTEM" />), /tl-actor__type">System</);
  });

  it('section tabs mark the current section and render unbuilt ones as non-links', () => {
    const html = render(
      <SectionTabs
        label="Organization sections"
        tabs={[
          { label: 'Overview', href: '/o', active: true },
          { label: 'Activity', href: '/o?tab=Activity' },
          { label: 'Opportunities', href: '/o', soon: true },
        ]}
      />,
    );
    assert.match(html, /<nav class="crm-section-tabs" aria-label="Organization sections">/);
    assert.match(html, /<a[^>]*aria-current="page"[^>]*>Overview<\/a>/);
    assert.equal((html.match(/aria-current/g) ?? []).length, 1);
    assert.match(html, /<span class="crm-section-tab is-disabled" aria-disabled="true">Opportunities<span class="crm-section-tab__soon">Soon<\/span><\/span>/);
    assert.equal(/href="[^"]*"[^>]*>Opportunities/.test(html), false);
  });

  it('a failed read says so, distinctly from a missing configuration, without the raw error', () => {
    const failed = render(<CrmLoadError surface="Search" failure={{ ok: false, cause: 'read-failed', message: 'connect ECONNREFUSED db.internal:5432' }} />);
    assert.match(failed, /role="alert"/);
    assert.match(failed, /Search is unavailable/);
    assert.equal(failed.includes('ECONNREFUSED'), false);
    const unconfigured = render(<CrmLoadError surface="Search" failure={{ ok: false, cause: 'not-configured', message: 'x' }} />);
    assert.match(unconfigured, /no database configured/);
    assert.notEqual(failed, unconfigured);
  });
});
