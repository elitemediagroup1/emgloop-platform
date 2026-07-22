// Work Type catalog + vocabularies (Start Work).
//
// A "Work Type" is the reusable template for a piece of work. It is NOT a new
// model — it is the existing Blueprint (packages/database schema `blueprints`),
// adapted: display name = Blueprint.name, description = Blueprint.description,
// active = Blueprint.status, and the extra configuration (category, default
// responsibility, default priority, default assignee, default requirements, sort
// order) lives in Blueprint.metadata. This file only holds the plain-English
// vocabularies and the STARTER catalog an admin can install into their org — it
// is a menu of definitions, never auto-seeded operational data.
//
// (Production applies only `prisma generate`, so a brand-new table is not an
// option; adapting Blueprint is both the correct call per the boundary rules and
// the only safe one. See CLAUDE.md.)

/** Work priorities, low→urgent. Nothing defaults to urgent. */
export const WORK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type WorkPriority = (typeof WORK_PRIORITIES)[number];

export const PRIORITY_LABELS: Record<WorkPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

/**
 * Responsibility keys and their plain-English labels. A responsibility is an area
 * of ownership referenced by KEY; the raw key never reaches the screen. There is
 * no automatic key→person resolver in this platform, so assignment is by explicit
 * team member or the work type's configured default — the responsibility is
 * recorded as honest context, not a fake auto-router.
 */
export const RESPONSIBILITY_LABELS: Record<string, string> = {
  CALLGRID_SETUP: 'CallGrid Setup',
  CALLGRID_OPTIMIZATION: 'CallGrid Optimization',
  CALLGRID_REVIEW: 'CallGrid Review',
  CONTRACT_REVIEW: 'Contract Review',
  CREATIVE_REVIEW: 'Creative Review',
  ACCOUNTING_REVIEW: 'Accounting Review',
  CREATOR_MANAGEMENT: 'Creator Management',
  SALES_FOLLOW_UP: 'Sales & Follow-Up',
  ADMINISTRATION: 'Administration',
  GENERAL: 'General',
};

export function responsibilityLabel(key: string | null | undefined): string {
  return (key && RESPONSIBILITY_LABELS[key]) || 'General';
}

/** The relation types a piece of work may optionally link to. Only entities the
 *  platform actually has data for are enabled; the rest are honestly omitted at
 *  the UI layer. 'none' means "not linked to anything". */
export const WORK_RELATION_TYPES = [
  'none', 'buyer', 'vendor', 'source', 'destination', 'campaign',
  'company', 'contact', 'creator', 'invoice', 'other',
] as const;
export type WorkRelationType = (typeof WORK_RELATION_TYPES)[number];

export const RELATION_LABELS: Record<WorkRelationType, string> = {
  none: 'Not linked to anything',
  buyer: 'Buyer', vendor: 'Vendor', source: 'Source', destination: 'Destination',
  campaign: 'Campaign', company: 'Company', contact: 'Contact', creator: 'Creator',
  invoice: 'Invoice', other: 'Other',
};

/** The approved starter categories, in display order. */
export const WORK_TYPE_CATEGORIES = [
  'CallGrid Operations',
  'Sales and Relationships',
  'Creator Operations',
  'Accounting',
  'Content and Creative',
  'Administration',
  'General',
] as const;
export type WorkTypeCategory = (typeof WORK_TYPE_CATEGORIES)[number];

export interface StarterWorkType {
  /** Stable key, unique within the catalog (also stored on the Blueprint so an
   *  install is idempotent and a rename never orphans it). */
  key: string;
  name: string;
  category: WorkTypeCategory;
  responsibility: string;
  defaultPriority: WorkPriority;
}

function t(
  category: WorkTypeCategory,
  responsibility: string,
  names: string[],
  defaultPriority: WorkPriority = 'normal',
): StarterWorkType[] {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const cat = slug(category);
  return names.map((name) => ({ key: `${cat}.${slug(name)}`, name, category, responsibility, defaultPriority }));
}

/** The initial approved Work Types (2C). A menu of definitions an admin installs
 *  once; thereafter every Work Type is a normal, editable Blueprint row. */
export const WORK_TYPE_CATALOG: StarterWorkType[] = [
  ...t('CallGrid Operations', 'CALLGRID_SETUP', [
    'Buyer Setup', 'Vendor Setup', 'Destination Setup', 'Source Setup', 'Campaign Setup',
  ]),
  ...t('CallGrid Operations', 'CALLGRID_OPTIMIZATION', [
    'Routing Change', 'Cap Review', 'CallGrid Optimization',
  ]),
  ...t('CallGrid Operations', 'CALLGRID_REVIEW', [
    'Performance Review', 'Call Quality Review', 'Bid/Rejection Review', 'CallGrid Investigation',
  ]),
  ...t('CallGrid Operations', 'CALLGRID_SETUP', ['General CallGrid Work']),
  ...t('Sales and Relationships', 'SALES_FOLLOW_UP', [
    'Lead Follow-Up', 'Brand Outreach', 'Buyer Outreach', 'Vendor Outreach',
    'Partnership Follow-Up', 'Contract Follow-Up', 'Meeting Follow-Up', 'General Relationship Work',
  ]),
  ...t('Creator Operations', 'CREATOR_MANAGEMENT', [
    'Creator Outreach', 'Creator Onboarding', 'Brand Partnership', 'Campaign Coordination',
    'Creator Payment', 'Creator Performance Review', 'General Creator Work',
  ]),
  ...t('Creator Operations', 'CONTRACT_REVIEW', ['Contract Review']),
  ...t('Creator Operations', 'CREATIVE_REVIEW', ['Content Review', 'Creative Approval']),
  ...t('Accounting', 'ACCOUNTING_REVIEW', [
    'Invoice Review', 'Invoice Reconciliation', 'Bill Payment', 'Customer Payment Follow-Up',
    'CallGrid Payout Reconciliation', 'Creator Payout', 'Expense Review', 'QuickBooks Entry',
    'General Accounting Work',
  ]),
  ...t('Content and Creative', 'CREATIVE_REVIEW', [
    'Creative Request', 'Creative Review', 'Video Editing', 'Quality Control',
    'Landing Page Review', 'URL Review', 'Content Approval', 'General Creative Work',
  ]),
  ...t('Administration', 'ADMINISTRATION', [
    'Team Onboarding', 'Access Change', 'User Invitation', 'Documentation',
    'Compliance Review', 'General Administrative Work',
  ]),
  ...t('General', 'GENERAL', ['General Task', 'Custom Work']),
];
