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
]);
