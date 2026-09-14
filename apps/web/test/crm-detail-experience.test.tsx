// Structural tests for PR C — Shared CRM Context / Detail Experience.
//
// Verifies that the customer detail and organization detail pages adopt
// the Phase 1 timeline primitives and that the organization Activity tab
// renders real data using the shared visual language.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CUSTOMER_SRC = readFileSync(
  join(__dirname, '..', 'src', 'app', 'crm', 'customers', '[id]', 'page.tsx'),
  'utf-8',
);

const ORG_SRC = readFileSync(
  join(__dirname, '..', 'src', 'app', 'crm', 'organizations', '[id]', 'page.tsx'),
  'utf-8',
);

const TIMELINE_SRC = readFileSync(
  join(__dirname, '..', 'src', 'crm', 'timeline.tsx'),
  'utf-8',
);

describe('Customer detail — timeline primitive adoption', () => {
  it('imports timeline primitives', () => {
    assert.ok(
      CUSTOMER_SRC.includes("from '../../../../crm/timeline'"),
      'Customer detail must import from crm/timeline',
    );
  });

  it('uses Timeline component in interaction timeline tab', () => {
    assert.ok(
      CUSTOMER_SRC.includes('<Timeline>') && CUSTOMER_SRC.includes('fromInteraction'),
      'Timeline tab must use Timeline + fromInteraction adapter',
    );
  });

  it('uses EmptyTimeline for empty states instead of raw HTML', () => {
    const emptyTimelineCount = (CUSTOMER_SRC.match(/<EmptyTimeline/g) ?? []).length;
    assert.ok(
      emptyTimelineCount >= 3,
      `Expected at least 3 EmptyTimeline usages, found ${emptyTimelineCount}`,
    );
  });

  it('uses TimelineItem in Messages tab', () => {
    const messagesSection = CUSTOMER_SRC.slice(
      CUSTOMER_SRC.indexOf("activeTab === 'Messages'"),
    );
    assert.ok(
      messagesSection.includes('<TimelineItem'),
      'Messages tab must use TimelineItem',
    );
  });

  it('uses TimelineItem in Bookings tab', () => {
    const bookingsSection = CUSTOMER_SRC.slice(
      CUSTOMER_SRC.indexOf("activeTab === 'Bookings'"),
    );
    assert.ok(
      bookingsSection.includes('<TimelineItem'),
      'Bookings tab must use TimelineItem',
    );
  });

  it('uses TimelineItem in Signals tab', () => {
    const signalsSection = CUSTOMER_SRC.slice(
      CUSTOMER_SRC.indexOf("activeTab === 'Signals'"),
    );
    assert.ok(
      signalsSection.includes('<TimelineItem'),
      'Signals tab must use TimelineItem',
    );
  });

  it('uses TimelineItem in AI Activity tab', () => {
    const aiSection = CUSTOMER_SRC.slice(
      CUSTOMER_SRC.indexOf("activeTab === 'AI Activity'"),
    );
    assert.ok(
      aiSection.includes('<TimelineItem'),
      'AI Activity tab must use TimelineItem',
    );
  });

  it('preserves domain-specific badge colors via badgeColor', () => {
    assert.ok(
      CUSTOMER_SRC.includes('badgeColor: KIND_COLOR'),
      'Timeline tab must pass KIND_COLOR as badgeColor',
    );
    assert.ok(
      CUSTOMER_SRC.includes("badgeColor: 'var(--crm-purple)'"),
      'AI Activity tab must pass purple badgeColor',
    );
  });
});

describe('Organization detail — Activity tab', () => {
  it('imports timeline primitives', () => {
    assert.ok(
      ORG_SRC.includes("from '../../../../crm/timeline'"),
      'Organization detail must import from crm/timeline',
    );
  });

  it('has a working Activity tab (not disabled)', () => {
    assert.ok(
      ORG_SRC.includes("tab=Activity"),
      'Activity tab must link to ?tab=Activity',
    );
    assert.ok(
      !ORG_SRC.includes("aria-disabled=\"true\">Activity"),
      'Activity tab must not be disabled',
    );
  });

  it('loads recent activity data from inboxFeed', () => {
    assert.ok(
      ORG_SRC.includes('inboxFeed'),
      'Must load recent activity via crmRepos.crm.inboxFeed',
    );
  });

  it('renders activity using Timeline + fromInboxItem', () => {
    assert.ok(
      ORG_SRC.includes('<Timeline>') && ORG_SRC.includes('fromInboxItem'),
      'Activity tab must use Timeline + fromInboxItem',
    );
  });

  it('renders audit trail using AuditEventRow + fromAuditView', () => {
    assert.ok(
      ORG_SRC.includes('<AuditEventRow') && ORG_SRC.includes('fromAuditView'),
      'Audit section must use AuditEventRow + fromAuditView',
    );
  });

  it('uses EmptyTimeline for empty states', () => {
    assert.ok(
      ORG_SRC.includes('<EmptyTimeline'),
      'Empty activity/audit states must use EmptyTimeline',
    );
  });

  it('remains tenant-scoped (organization from session, not path)', () => {
    assert.ok(
      ORG_SRC.includes('requireCrmContext'),
      'Must use requireCrmContext for org scope',
    );
    assert.ok(
      ORG_SRC.includes('params.id !== ctx.organizationId'),
      'Must reject cross-org access',
    );
  });
});

describe('Timeline primitives — fromInteraction adapter', () => {
  it('exports fromInteraction adapter', () => {
    assert.ok(
      TIMELINE_SRC.includes('export function fromInteraction'),
      'timeline.tsx must export fromInteraction',
    );
  });

  it('fromInteraction sets source to interaction', () => {
    const match = TIMELINE_SRC.match(
      /fromInteraction[\s\S]*?source:\s*'(\w+)'/,
    );
    assert.ok(match, 'fromInteraction must set source');
    assert.equal(match![1], 'interaction');
  });

  it('supports badgeColor on TimelineEntry', () => {
    assert.ok(
      TIMELINE_SRC.includes('badgeColor?: string'),
      'TimelineEntry must have optional badgeColor field',
    );
  });

  it('ActivityTypeBadge respects color prop', () => {
    const badgeFn = TIMELINE_SRC.slice(
      TIMELINE_SRC.indexOf('export function ActivityTypeBadge'),
    );
    assert.ok(
      badgeFn.includes('color?: string'),
      'ActivityTypeBadge must accept optional color prop',
    );
    assert.ok(
      badgeFn.includes('style={{ background: color }}'),
      'ActivityTypeBadge must apply color as inline style when provided',
    );
  });
});
