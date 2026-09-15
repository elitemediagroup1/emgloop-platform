// Structural tests for Phase 1 timeline primitives.
//
// These tests verify the timeline component contract by reading source files
// and asserting structural properties — the same pattern as crm-authority.test.tsx.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TIMELINE_SRC = readFileSync(
  join(__dirname, '..', 'src', 'crm', 'timeline.tsx'),
  'utf-8',
);

const PAGE_SRC = readFileSync(
  join(__dirname, '..', 'src', 'app', 'crm', 'page.tsx'),
  'utf-8',
);

const CSS_SRC = readFileSync(
  join(__dirname, '..', 'src', 'app', 'crm', 'design-system.css'),
  'utf-8',
);

describe('Timeline primitives — component contract', () => {
  it('exports Timeline, TimelineItem, ActivityTypeBadge, ActorDisplay, ProvenanceDisplay, Timestamp, EmptyTimeline, AuditEventRow', () => {
    const required = [
      'Timeline',
      'TimelineItem',
      'ActivityTypeBadge',
      'ActorDisplay',
      'ProvenanceDisplay',
      'Timestamp',
      'EmptyTimeline',
      'AuditEventRow',
    ];
    for (const name of required) {
      assert.ok(
        TIMELINE_SRC.includes(`export function ${name}`),
        `timeline.tsx must export ${name}`,
      );
    }
  });

  it('exports adapter functions for each data source', () => {
    assert.ok(
      TIMELINE_SRC.includes('export function fromInboxItem'),
      'Must export fromInboxItem adapter for interaction data',
    );
    assert.ok(
      TIMELINE_SRC.includes('export function fromAuditView'),
      'Must export fromAuditView adapter for audit data',
    );
    assert.ok(
      TIMELINE_SRC.includes('export function fromCustomerActivity'),
      'Must export fromCustomerActivity adapter for customer activity data',
    );
  });

  it('defines TimelineSource type preserving provenance', () => {
    assert.ok(
      TIMELINE_SRC.includes("'interaction'"),
      'TimelineSource must include interaction',
    );
    assert.ok(
      TIMELINE_SRC.includes("'audit'"),
      'TimelineSource must include audit',
    );
    assert.ok(
      TIMELINE_SRC.includes("'state-change'"),
      'TimelineSource must include state-change',
    );
    assert.ok(
      TIMELINE_SRC.includes("'event'"),
      'TimelineSource must include event',
    );
  });

  it('retains source provenance in adapters — never collapses authorities', () => {
    const inboxMatch = TIMELINE_SRC.match(
      /fromInboxItem[\s\S]*?source:\s*'(\w+)'/,
    );
    assert.ok(inboxMatch, 'fromInboxItem must set source');
    assert.equal(inboxMatch![1], 'interaction', 'Inbox items must have source=interaction');

    const auditMatch = TIMELINE_SRC.match(
      /fromAuditView[\s\S]*?source:\s*'(\w+)'/,
    );
    assert.ok(auditMatch, 'fromAuditView must set source');
    assert.equal(auditMatch![1], 'audit', 'Audit views must have source=audit');
  });

  it('formats time through the Loop Time Authority instead of its own helper', () => {
    assert.ok(
      TIMELINE_SRC.includes("from '../time/viewer-time'"),
      'Must read the reader\'s time from the Time Authority',
    );
    assert.ok(
      !TIMELINE_SRC.includes('function relTime') && !/toLocale(Date|Time)?String\(/.test(TIMELINE_SRC),
      'Must not define its own relative time or format dates on the server clock',
    );
  });

  it('renders ActivityTypeBadge with source-specific CSS modifiers', () => {
    assert.ok(TIMELINE_SRC.includes('tl-badge--in'), 'Must have inbound badge variant');
    assert.ok(TIMELINE_SRC.includes('tl-badge--out'), 'Must have outbound badge variant');
    assert.ok(TIMELINE_SRC.includes('tl-badge--audit'), 'Must have audit badge variant');
  });

  it('TimelineItem includes ProvenanceDisplay so source is always visible', () => {
    const itemFn = TIMELINE_SRC.match(
      /export function TimelineItem[\s\S]*?^}/m,
    );
    assert.ok(itemFn, 'TimelineItem must be exported');
    assert.ok(
      itemFn![0].includes('ProvenanceDisplay'),
      'TimelineItem must render ProvenanceDisplay',
    );
  });

  it('does not fabricate data or contain hardcoded demo content', () => {
    const fakes = ['demo', 'sample', 'mock', 'placeholder', 'lorem', 'test data', 'fake'];
    for (const word of fakes) {
      assert.ok(
        !TIMELINE_SRC.toLowerCase().includes(word),
        `timeline.tsx must not contain "${word}"`,
      );
    }
  });
});

describe('Command Center integration', () => {
  it('imports timeline primitives', () => {
    assert.ok(
      PAGE_SRC.includes("from '../../crm/timeline'"),
      'Command Center must import from crm/timeline',
    );
  });

  it('uses Timeline component for recent activity', () => {
    assert.ok(
      PAGE_SRC.includes('<Timeline>') && PAGE_SRC.includes('fromInboxItem'),
      'Recent activity section must use Timeline + fromInboxItem',
    );
  });

  it('uses AuditEventRow for audit events', () => {
    assert.ok(
      PAGE_SRC.includes('<AuditEventRow') && PAGE_SRC.includes('fromAuditView'),
      'Audit section must use AuditEventRow + fromAuditView',
    );
  });

  it('uses EmptyTimeline for empty states', () => {
    assert.ok(
      PAGE_SRC.includes('<EmptyTimeline'),
      'Empty activity/audit states must use EmptyTimeline',
    );
  });

  it('no longer has inline relTime implementation', () => {
    assert.ok(
      !PAGE_SRC.includes('function relTime'),
      'Command Center should use timeline Timestamp, not its own relTime',
    );
  });
});

describe('Design system CSS', () => {
  it('defines timeline primitive styles', () => {
    const requiredClasses = ['.tl ', '.tl-item', '.tl-badge', '.tl-content', '.tl-title', '.tl-meta', '.tl-empty'];
    for (const cls of requiredClasses) {
      assert.ok(
        CSS_SRC.includes(cls),
        `design-system.css must define ${cls.trim()}`,
      );
    }
  });

  it('defines source-specific badge colors', () => {
    assert.ok(CSS_SRC.includes('.tl-badge--in'), 'Must style inbound badge');
    assert.ok(CSS_SRC.includes('.tl-badge--out'), 'Must style outbound badge');
    assert.ok(CSS_SRC.includes('.tl-badge--audit'), 'Must style audit badge');
    assert.ok(CSS_SRC.includes('.tl-badge--state'), 'Must style state-change badge');
    assert.ok(CSS_SRC.includes('.tl-badge--event'), 'Must style event badge');
  });

  it('uses only existing --crm-* design tokens', () => {
    const customProps = CSS_SRC.match(/var\(--(?!crm-)[a-z-]+\)/g) ?? [];
    const filtered = customProps.filter(
      (p) => !p.includes('--crm-') && p !== 'var(--crm-border-soft)',
    );
    // Allow no non-crm custom properties in the timeline section
    const timelineSection = CSS_SRC.slice(CSS_SRC.indexOf('Timeline primitives'));
    const tlCustom = (timelineSection.match(/var\(--[a-z-]+\)/g) ?? []).filter(
      (p) => !p.startsWith('var(--crm-'),
    );
    assert.equal(tlCustom.length, 0, 'Timeline CSS must only use --crm-* tokens');
  });
});
