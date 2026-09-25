// The domain registry and the source registry of Loop Intelligence. PR 2 (the fabric), 2026-09-26.
//
// ONE LIST OF DOMAINS, ONE LIST OF SOURCES. Every area of Loop that can hold intelligence is a DOMAIN
// here, with the scope its intelligence has, the surface it lives on, what Home does with it, the task
// that reads it (null until one is commissioned), whether its readings may feed a synthesis, and the
// family of evidence it reads. Every governed SOURCE Loop copies evidence from is listed with the
// domains it may feed and the scope that evidence has. A test proves the two agree and that nothing
// private can feed an organization domain.
//
// TERMINOLOGY (reconciled 2026-09-26; docs/architecture/loop-intelligence-fabric.md §2). The codebase
// grew several names for the same area. The domain key is the ONE name intelligence uses; `aka` lists
// the others so a reader can map them, and nothing else may introduce a new one:
//   CALLGRID   "Marketplace", "CallGrid Intelligence" (/app/admin/marketplace)
//   CAMPAIGNS  "Campaigns" -- CallGrid campaigns, NOT a marketing-campaign system (none is built)
//   PIPELINE   "Intake", "Intake Board", "pipeline" (/crm/pipeline); Home tile key 'intake'
//   CRM        "People", "Customers", "Parties" (/app/crm/people)
//   CREATORS   "Creator Hub", "Creators" (/app/admin/creator-hub)
//   WORK       "Work OS", "My Work", "Team Work" -- human work execution, not a CRM Workflow
//   WEBSITE    "Traffic", "Analytics", "website intelligence" (/crm/traffic, /crm/analytics)
//
// NO MODEL READS A SOURCE. A source here is where Loop's own governed copy of evidence came from.
// Producers read that copy through repositories; a model is only ever handed the bounded context a
// producer assembled (`access: 'LOOP_GOVERNED_COPY'` on every source, pinned by a test).
//
// PURE. Data only.

import type { IntelligenceDigestScope, IntelligenceDomain } from './intelligence-digest';

/** The families of evidence a domain reads. A reading's provenance names the family through its sources. */
export const INTELLIGENCE_EVIDENCE_FAMILIES = [
  'COMMUNICATION',
  'SCHEDULE',
  'CALL_ECONOMICS',
  'LEAD_INTAKE',
  'CUSTOMER_RECORDS',
  'CREATOR_RECORDS',
  'WORK_RECORDS',
  'WEB_ACTIVITY',
] as const;
export type IntelligenceEvidenceFamily = (typeof INTELLIGENCE_EVIDENCE_FAMILIES)[number];

/** Home's tile keys (`apps/web/src/app/app/_home/tiles.ts`). */
export type IntelligenceHomeTileKey = 'mail' | 'chats' | 'calendar' | 'work' | 'intake' | 'callgrid' | 'campaigns' | 'creators';

export type IntelligenceHomeDecision = { readonly tile: IntelligenceHomeTileKey } | { readonly tile: null; readonly reason: string };

/**
 * Who may read the domain's intelligence: the authority its surface already enforces. PRINCIPAL
 * intelligence is additionally readable only by its own principal, whatever this says.
 */
export interface IntelligenceReadAuthority {
  readonly permission: `${string}:${string}` | null;
  readonly workspace: 'ADMIN' | null;
}

export interface IntelligenceDomainEntry {
  readonly domain: IntelligenceDomain;
  readonly label: string;
  readonly aka: readonly string[];
  /** The scopes this domain's intelligence may have. */
  readonly scopes: readonly IntelligenceDigestScope[];
  /** Where the domain lives in Loop. Every path is a real route in the navigation registry. */
  readonly surfaces: readonly string[];
  readonly home: IntelligenceHomeDecision;
  readonly readAuthority: IntelligenceReadAuthority;
  /**
   * The governed AI task that writes this domain's model reading, when that task is ACTIVATED. Defined is
   * not commissioned: every task but Chats' is inactive until the deployment lists it (LOOP_AI_TASKS).
   */
  readonly readingTask: string | null;
  /** Whether this domain's readings may later feed a synthesis (within the eligibility its scope gives). */
  readonly synthesis: 'CONTRIBUTES' | 'EXCLUDED';
  readonly evidenceFamilies: readonly IntelligenceEvidenceFamily[];
}

const SELF: IntelligenceReadAuthority = { permission: 'employeeIntelligence:view', workspace: null };

export const INTELLIGENCE_DOMAIN_REGISTRY: readonly IntelligenceDomainEntry[] = Object.freeze([
  {
    domain: 'CHATS',
    label: 'Chats',
    aka: ['Telegram triage', 'Chats Intelligence'],
    scopes: ['PRINCIPAL'],
    surfaces: ['/app/chats'],
    home: { tile: 'chats' },
    readAuthority: { permission: 'googleWorkspace:view', workspace: null },
    // Chats readings are written in the same call as triage v4 (PR B); the generic loop never runs it.
    readingTask: 'telegram.content.triage',
    synthesis: 'CONTRIBUTES',
    evidenceFamilies: ['COMMUNICATION'],
  },
  {
    domain: 'MAIL',
    label: 'Mail',
    aka: ['Gmail', 'mailbox'],
    scopes: ['PRINCIPAL'],
    surfaces: ['/app/mail'],
    home: { tile: 'mail' },
    readAuthority: SELF,
    readingTask: 'mail.domain.reading',
    synthesis: 'CONTRIBUTES',
    evidenceFamilies: ['COMMUNICATION'],
  },
  {
    domain: 'CALENDAR',
    label: 'Calendar',
    aka: ['Google Calendar', 'day'],
    scopes: ['PRINCIPAL'],
    surfaces: ['/app/calendar'],
    home: { tile: 'calendar' },
    readAuthority: SELF,
    readingTask: 'calendar.domain.reading',
    synthesis: 'CONTRIBUTES',
    evidenceFamilies: ['SCHEDULE'],
  },
  {
    domain: 'CALLGRID',
    label: 'CallGrid',
    aka: ['Marketplace', 'CallGrid Intelligence'],
    scopes: ['ORGANIZATION'],
    surfaces: ['/app/admin/marketplace'],
    home: { tile: 'callgrid' },
    readAuthority: { permission: 'intelligence:view', workspace: 'ADMIN' },
    readingTask: 'callgrid.domain.reading',
    synthesis: 'CONTRIBUTES',
    evidenceFamilies: ['CALL_ECONOMICS'],
  },
  {
    domain: 'CAMPAIGNS',
    label: 'Campaigns',
    aka: ['CallGrid campaigns'],
    scopes: ['ORGANIZATION'],
    surfaces: ['/app/admin/marketplace/campaigns'],
    home: { tile: 'campaigns' },
    readAuthority: { permission: 'intelligence:view', workspace: 'ADMIN' },
    readingTask: 'campaigns.domain.reading',
    synthesis: 'CONTRIBUTES',
    evidenceFamilies: ['CALL_ECONOMICS'],
  },
  {
    domain: 'PIPELINE',
    label: 'Intake',
    aka: ['Intake Board', 'pipeline', 'leads'],
    scopes: ['ORGANIZATION'],
    surfaces: ['/crm/pipeline'],
    home: { tile: 'intake' },
    readAuthority: { permission: 'pipeline:view', workspace: null },
    readingTask: 'pipeline.domain.reading',
    synthesis: 'CONTRIBUTES',
    evidenceFamilies: ['LEAD_INTAKE', 'WEB_ACTIVITY'],
  },
  {
    domain: 'CRM',
    label: 'People',
    aka: ['Customers', 'Parties', 'Relationships'],
    scopes: ['ORGANIZATION'],
    surfaces: ['/app/crm/people'],
    home: { tile: null, reason: 'People is a record surface; Home leads with the domains that change daily, and CRM readings reach Home only through a future synthesis.' },
    readAuthority: { permission: 'identityResolution:view', workspace: null },
    readingTask: 'crm.domain.reading',
    synthesis: 'CONTRIBUTES',
    evidenceFamilies: ['CUSTOMER_RECORDS'],
  },
  {
    domain: 'CREATORS',
    label: 'Creators',
    aka: ['Creator Hub'],
    scopes: ['ORGANIZATION'],
    surfaces: ['/app/admin/creator-hub'],
    home: { tile: 'creators' },
    readAuthority: { permission: null, workspace: 'ADMIN' },
    readingTask: 'creators.domain.reading',
    synthesis: 'CONTRIBUTES',
    evidenceFamilies: ['CREATOR_RECORDS'],
  },
  {
    domain: 'WORK',
    label: 'Work',
    aka: ['Work OS', 'My Work', 'Team Work'],
    // A person's own assigned work (PRINCIPAL) and the organization's work as a whole (ORGANIZATION).
    scopes: ['PRINCIPAL', 'ORGANIZATION'],
    surfaces: ['/app/admin/work'],
    home: { tile: 'work' },
    readAuthority: { permission: null, workspace: 'ADMIN' },
    readingTask: 'work.domain.reading',
    synthesis: 'CONTRIBUTES',
    evidenceFamilies: ['WORK_RECORDS'],
  },
  {
    domain: 'WEBSITE',
    label: 'Website',
    aka: ['Traffic', 'Analytics', 'website intelligence'],
    scopes: ['ORGANIZATION'],
    // /crm/analytics holds website events; /crm/traffic is CALL traffic (CallGrid), not website traffic.
    surfaces: ['/crm/analytics'],
    home: { tile: null, reason: 'No Home tile is approved for website traffic; it is read on Analytics, and reaches Home only as Intake when it produces a lead.' },
    readAuthority: { permission: 'analytics:view', workspace: null },
    readingTask: 'website.domain.reading',
    synthesis: 'CONTRIBUTES',
    evidenceFamilies: ['WEB_ACTIVITY'],
  },
] satisfies IntelligenceDomainEntry[]);

export function intelligenceDomainEntry(domain: string): IntelligenceDomainEntry | null {
  return INTELLIGENCE_DOMAIN_REGISTRY.find((d) => d.domain === domain) ?? null;
}

/** Whether a domain's intelligence may have this scope. Unknown domain: false. */
export function intelligenceDomainAllowsScope(domain: string, scope: string): boolean {
  return !!intelligenceDomainEntry(domain)?.scopes.some((s) => s === scope);
}

// --- Sources ---------------------------------------------------------------------------------------

/** Why Loop holds a source's evidence (matches the digest repository's consent bases). */
export type IntelligenceSourceBasis = 'CONTENT_AUTHORIZATION' | 'SOURCE_CONNECTION_GRANT' | 'LOOP_RECORDS';

export interface IntelligenceSourceEntry {
  /** Provider-neutral id. Named for where the evidence came from, never a vendor's product inside domain code. */
  readonly sourceId: string;
  readonly label: string;
  /** The scope the evidence has: a person's private copy, or the organization's records. */
  readonly scopes: readonly IntelligenceDigestScope[];
  readonly basis: IntelligenceSourceBasis;
  readonly domains: readonly IntelligenceDomain[];
  readonly evidenceFamily: IntelligenceEvidenceFamily;
  /** How often Loop's copy is refreshed, as the ingestion that owns it runs today. */
  readonly cadence: 'PUSH' | 'POLL' | 'ON_VISIT' | 'ON_WRITE';
  /** Every source is read only as Loop's own governed copy; nothing hands a model a source. */
  readonly access: 'LOOP_GOVERNED_COPY';
}

export const INTELLIGENCE_SOURCE_REGISTRY: readonly IntelligenceSourceEntry[] = Object.freeze([
  { sourceId: 'TELEGRAM', label: 'Telegram conversations', scopes: ['PRINCIPAL'], basis: 'CONTENT_AUTHORIZATION', domains: ['CHATS'], evidenceFamily: 'COMMUNICATION', cadence: 'PUSH', access: 'LOOP_GOVERNED_COPY' },
  { sourceId: 'GMAIL', label: 'Mail', scopes: ['PRINCIPAL'], basis: 'SOURCE_CONNECTION_GRANT', domains: ['MAIL'], evidenceFamily: 'COMMUNICATION', cadence: 'ON_VISIT', access: 'LOOP_GOVERNED_COPY' },
  { sourceId: 'GOOGLE_CALENDAR', label: 'Calendar', scopes: ['PRINCIPAL'], basis: 'SOURCE_CONNECTION_GRANT', domains: ['CALENDAR'], evidenceFamily: 'SCHEDULE', cadence: 'ON_VISIT', access: 'LOOP_GOVERNED_COPY' },
  { sourceId: 'CALLGRID', label: 'Call marketplace records', scopes: ['ORGANIZATION'], basis: 'LOOP_RECORDS', domains: ['CALLGRID', 'CAMPAIGNS'], evidenceFamily: 'CALL_ECONOMICS', cadence: 'PUSH', access: 'LOOP_GOVERNED_COPY' },
  { sourceId: 'WEBSITE_EVENTS', label: 'Website events', scopes: ['ORGANIZATION'], basis: 'LOOP_RECORDS', domains: ['WEBSITE', 'PIPELINE'], evidenceFamily: 'WEB_ACTIVITY', cadence: 'PUSH', access: 'LOOP_GOVERNED_COPY' },
  { sourceId: 'LOOP_INTAKE', label: 'Intake records', scopes: ['ORGANIZATION'], basis: 'LOOP_RECORDS', domains: ['PIPELINE'], evidenceFamily: 'LEAD_INTAKE', cadence: 'ON_WRITE', access: 'LOOP_GOVERNED_COPY' },
  { sourceId: 'LOOP_CRM', label: 'People and relationships', scopes: ['ORGANIZATION'], basis: 'LOOP_RECORDS', domains: ['CRM'], evidenceFamily: 'CUSTOMER_RECORDS', cadence: 'ON_WRITE', access: 'LOOP_GOVERNED_COPY' },
  { sourceId: 'LOOP_CREATORS', label: 'Creator Hub records', scopes: ['ORGANIZATION'], basis: 'LOOP_RECORDS', domains: ['CREATORS'], evidenceFamily: 'CREATOR_RECORDS', cadence: 'ON_WRITE', access: 'LOOP_GOVERNED_COPY' },
  { sourceId: 'LOOP_WORK', label: 'Work records', scopes: ['PRINCIPAL', 'ORGANIZATION'], basis: 'LOOP_RECORDS', domains: ['WORK'], evidenceFamily: 'WORK_RECORDS', cadence: 'ON_WRITE', access: 'LOOP_GOVERNED_COPY' },
] satisfies IntelligenceSourceEntry[]);

export function intelligenceSourceEntry(sourceId: string): IntelligenceSourceEntry | null {
  return INTELLIGENCE_SOURCE_REGISTRY.find((s) => s.sourceId === sourceId) ?? null;
}

/** The scopes a registered source's evidence may feed, or null for an unregistered source. */
export function intelligenceSourceScopes(sourceId: string): readonly IntelligenceDigestScope[] | null {
  return intelligenceSourceEntry(sourceId)?.scopes ?? null;
}

/**
 * Domains whose evidence is a person's private communication or schedule. Their intelligence is
 * PRINCIPAL only, forever: the database refuses an ORGANIZATION digest in any of them.
 */
export const PRIVATE_INTELLIGENCE_DOMAINS: readonly IntelligenceDomain[] = Object.freeze(['CHATS', 'MAIL', 'CALENDAR']);
