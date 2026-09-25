// The Loop Intelligence AI tasks (Phases D-G, 2026-09-26). Definitions only: a task here runs nowhere until
// the deployment ACTIVATES it (LOOP_AI_TASKS), a provider policy admits its data class, and a producer or
// action that calls it is itself activated. Merging this commissions nothing.
//
// Every task is READ_ONLY and publishes no tool. Each lands in exactly one governed store (the ownership
// rule it names): a digest, a Case's evidence, a person's work_briefs. None creates work; none sends.
//
// DATA CLASSES FOLLOW THE CONTEXT, NOT THE AMBITION. A person's own mail, calendar or briefing context can
// carry communication content: COMMUNICATION_CONTENT, readable only by that person (employeeIntelligence).
// An organization domain reading is built from Loop's own records as aggregates and canonical references,
// never names or free text: OPERATIONAL, and it runs as a named acting principal who holds the domain's
// read authority (the runtime has no service account).
//
// PURE.

import type { AiTaskDefinition } from './task';

const BACKGROUND_EXECUTION = Object.freeze({
  classes: Object.freeze(['INTERACTIVE'] as const),
  interactive: Object.freeze({ presentationBudgetMs: 10_000, executionDeadlineMs: 30_000, streaming: 'NONE' } as const),
  durable: null,
});

const HUMAN_ROLES = Object.freeze(['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY']);
const OPERATORS = Object.freeze(['OWNER', 'ADMIN', 'MANAGER']);

/**
 * MAIL CONTENT TRIAGE (Phase D). One mail thread of the person's own mailbox, read transiently through
 * their own Gmail connection under their own MAIL content authorization -- AND the counterparty-consent
 * governance decision, which is UNRESOLVED (see mail-content-governance.ts). Returns what is still owed
 * (and by whom, as the thread showed) and a typed reading; stored as the person's private MAIL digest.
 * The deterministic mail lanes are unchanged and still raise the correctable items.
 */
export const AI_TASK_MAIL_CONTENT_TRIAGE: AiTaskDefinition = Object.freeze({
  taskId: 'mail.content.triage',
  version: '1.0.0',
  capabilityRoute: 'GENERAL_REASONING',
  resultType: 'TRIAGE',
  resultOwner: Object.freeze({ authority: 'EMPLOYEE_INTELLIGENCE', subjectType: 'EMPLOYEE_MAIL_THREAD' } as const),
  execution: BACKGROUND_EXECUTION,
  sensitivityCeiling: 'COMMUNICATION_CONTENT',
  consequence: 'READ_ONLY',
  requires: Object.freeze([{ resource: 'employeeIntelligence', action: 'view' } as const]),
  invokerRoles: HUMAN_ROLES,
  outputSchemaId: 'mail-content-triage.v1',
  maxOutputTokens: 2000,
  timeoutMs: 20_000,
  tools: Object.freeze([]),
});

function personalDomainReading(taskId: string): AiTaskDefinition {
  return Object.freeze({
    taskId,
    version: '1.0.0',
    capabilityRoute: 'GENERAL_REASONING',
    resultType: 'ANALYSIS',
    resultOwner: Object.freeze({ authority: 'EMPLOYEE_INTELLIGENCE', subjectType: 'EMPLOYEE_DOMAIN' } as const),
    execution: BACKGROUND_EXECUTION,
    sensitivityCeiling: 'COMMUNICATION_CONTENT',
    consequence: 'READ_ONLY',
    requires: Object.freeze([{ resource: 'employeeIntelligence', action: 'view' } as const]),
    invokerRoles: HUMAN_ROLES,
    outputSchemaId: 'domain-reading.v1',
    maxOutputTokens: 2000,
    timeoutMs: 20_000,
    tools: Object.freeze([]),
  });
}

function organizationDomainReading(taskId: string, resource: string): AiTaskDefinition {
  return Object.freeze({
    taskId,
    version: '1.0.0',
    capabilityRoute: 'TECHNICAL_ANALYSIS',
    resultType: 'ANALYSIS',
    resultOwner: Object.freeze({ authority: 'LOOP_INTELLIGENCE', subjectType: 'ORGANIZATION_DOMAIN' } as const),
    execution: BACKGROUND_EXECUTION,
    sensitivityCeiling: 'OPERATIONAL',
    consequence: 'READ_ONLY',
    requires: Object.freeze([{ resource, action: 'view' } as const]),
    invokerRoles: OPERATORS,
    outputSchemaId: 'domain-reading.v1',
    maxOutputTokens: 2000,
    timeoutMs: 25_000,
    tools: Object.freeze([]),
  });
}

/** Phase D: a person's own mailbox, read from their MAIL thread digests and the deterministic lanes. */
export const AI_TASK_MAIL_DOMAIN_READING = personalDomainReading('mail.domain.reading');
/** Phase E: a person's own day, from their calendar and the work and threads connected to it. */
export const AI_TASK_CALENDAR_DOMAIN_READING = personalDomainReading('calendar.domain.reading');
/** Phase E: organization domains. Each its own task, so each is activated, budgeted and killed on its own. */
export const AI_TASK_CALLGRID_DOMAIN_READING = organizationDomainReading('callgrid.domain.reading', 'intelligence');
export const AI_TASK_CAMPAIGNS_DOMAIN_READING = organizationDomainReading('campaigns.domain.reading', 'intelligence');
export const AI_TASK_PIPELINE_DOMAIN_READING = organizationDomainReading('pipeline.domain.reading', 'pipeline');
export const AI_TASK_CRM_DOMAIN_READING = organizationDomainReading('crm.domain.reading', 'identityResolution');
export const AI_TASK_CREATORS_DOMAIN_READING = organizationDomainReading('creators.domain.reading', 'intelligence');
export const AI_TASK_WORK_DOMAIN_READING = organizationDomainReading('work.domain.reading', 'work');
export const AI_TASK_WEBSITE_DOMAIN_READING = organizationDomainReading('website.domain.reading', 'analytics');

// --- Phase F: situations ---------------------------------------------------------------------------

function situationTask(taskId: string, schemaId: string, owner: { authority: 'LOOP_INTELLIGENCE' | 'EMPLOYEE_INTELLIGENCE'; subjectType: string }, personal: boolean): AiTaskDefinition {
  return Object.freeze({
    taskId,
    version: '1.0.0',
    capabilityRoute: 'TECHNICAL_ANALYSIS',
    resultType: 'ANALYSIS',
    resultOwner: Object.freeze(owner) as AiTaskDefinition['resultOwner'],
    execution: BACKGROUND_EXECUTION,
    sensitivityCeiling: personal ? 'COMMUNICATION_CONTENT' : 'OPERATIONAL',
    consequence: 'READ_ONLY',
    requires: Object.freeze([personal ? ({ resource: 'employeeIntelligence', action: 'view' } as const) : ({ resource: 'intelligence', action: 'view' } as const)]),
    invokerRoles: personal ? HUMAN_ROLES : OPERATORS,
    outputSchemaId: schemaId,
    maxOutputTokens: 3000,
    timeoutMs: 25_000,
    tools: Object.freeze([]),
  });
}

/**
 * SITUATION SYNTHESIS (Phase F). A deterministic cluster of signals from several domains (shared entity
 * references, explicit links, a common window) and the open situations that might already be this one.
 * The model answers NEW / UPDATE / NONE with cited claims (situation-contracts.ts); Loop stores the answer
 * as a Case. The ORGANIZATION task reads only organization readings; the PRIVATE task reads one person's
 * own readings (and the organization's they may open) and its Case is theirs alone.
 */
export const AI_TASK_SITUATION_SYNTHESIS = situationTask('situation.synthesis', 'situation-synthesis.v1', { authority: 'LOOP_INTELLIGENCE', subjectType: 'SITUATION' }, false);
export const AI_TASK_PRIVATE_SITUATION_SYNTHESIS = situationTask('situation.synthesis.private', 'situation-synthesis.v1', { authority: 'EMPLOYEE_INTELLIGENCE', subjectType: 'EMPLOYEE_SITUATION' }, true);
/**
 * SITUATION VERIFICATION (Phase F). An INDEPENDENT reader -- routed OTHER_THAN_SUBJECT, so never the
 * provider that wrote the claims -- marks each claim SUPPORTED / UNSUPPORTED / UNCLEAR against the same
 * cited evidence. With no independent provider commissioned the check does not run and the situation says
 * so (UNAVAILABLE); it is never served by the same provider and called independent.
 */
export const AI_TASK_SITUATION_VERIFICATION = situationTask('situation.verify', 'situation-verification.v1', { authority: 'LOOP_INTELLIGENCE', subjectType: 'SITUATION_CLAIMS' }, false);
export const AI_TASK_PRIVATE_SITUATION_VERIFICATION = situationTask('situation.verify.private', 'situation-verification.v1', { authority: 'EMPLOYEE_INTELLIGENCE', subjectType: 'EMPLOYEE_SITUATION_CLAIMS' }, true);

// --- Phase G: the Briefing -------------------------------------------------------------------------

/**
 * LOOP BRIEFING (Phase G). One person's Briefing, composed from the artifacts Loop already holds for them
 * (their digests, the organization readings they may open, the situations visible to them, their open
 * work) -- ordered and said, never discovered (briefing-contract.ts). Stored in their own work_briefs.
 */
export const AI_TASK_LOOP_BRIEFING = Object.freeze({
  taskId: 'loop.briefing.compose',
  version: '1.0.0',
  capabilityRoute: 'COMMUNICATION',
  resultType: 'ANALYSIS',
  resultOwner: Object.freeze({ authority: 'EMPLOYEE_INTELLIGENCE', subjectType: 'EMPLOYEE_BRIEFING' } as const),
  execution: BACKGROUND_EXECUTION,
  sensitivityCeiling: 'COMMUNICATION_CONTENT',
  consequence: 'READ_ONLY',
  requires: Object.freeze([{ resource: 'employeeIntelligence', action: 'view' } as const]),
  invokerRoles: HUMAN_ROLES,
  outputSchemaId: 'loop-briefing.v1',
  maxOutputTokens: 2000,
  timeoutMs: 25_000,
  tools: Object.freeze([]),
}) as AiTaskDefinition;

/** Every Loop Intelligence task, in phase order. */
export const AI_INTELLIGENCE_TASKS: readonly AiTaskDefinition[] = Object.freeze([
  AI_TASK_MAIL_CONTENT_TRIAGE,
  AI_TASK_MAIL_DOMAIN_READING,
  AI_TASK_CALENDAR_DOMAIN_READING,
  AI_TASK_CALLGRID_DOMAIN_READING,
  AI_TASK_CAMPAIGNS_DOMAIN_READING,
  AI_TASK_PIPELINE_DOMAIN_READING,
  AI_TASK_CRM_DOMAIN_READING,
  AI_TASK_CREATORS_DOMAIN_READING,
  AI_TASK_WORK_DOMAIN_READING,
  AI_TASK_WEBSITE_DOMAIN_READING,
  AI_TASK_SITUATION_SYNTHESIS,
  AI_TASK_PRIVATE_SITUATION_SYNTHESIS,
  AI_TASK_SITUATION_VERIFICATION,
  AI_TASK_PRIVATE_SITUATION_VERIFICATION,
  AI_TASK_LOOP_BRIEFING,
]);
