/**
 * Work OS - Workflow Template
 *
 * A WorkflowTemplate is the top-level, reusable blueprint that composes stage
 * definitions, the transitions between them, and any decision points into a
 * complete description of how work flows. One template can describe a website
 * project, creator onboarding, a government proposal, sales, CRM onboarding, a
 * marketplace investigation, marketing, or internal operations - the shape is
 * the same, only the stages and rules differ. Nothing is hardcoded to a
 * particular process.
 *
 * A template is pure data. Instantiating it against real work (producing the
 * structural Workflow / WorkflowStage from PR #70) is a runtime concern that is
 * explicitly out of scope here.
 *
 * Pure contracts only.
 */

import type { TenantScope, Metadata } from "@emgloop/shared";
import type {
  WorkflowTemplateId,
  StageDefinitionId,
} from "./workflow-ids";
import type { StageDefinition } from "./stages";
import type { Transition, DecisionPoint } from "./transitions";

/** The domain a template is intended for. Free-form, provider-neutral. */
export const WORKFLOW_DOMAINS = [
  "website",
  "creator_onboarding",
  "government_proposal",
  "sales",
  "crm_onboarding",
  "marketplace_investigation",
  "marketing",
  "internal_operations",
  "custom",
] as const;
export type WorkflowDomain = (typeof WORKFLOW_DOMAINS)[number];

/**
 * A reusable, declarative description of how work moves. Stages are addressed by
 * id within `stages`; `start` names the entry stage and `terminals` the
 * stages at which work leaves the flow. The transition graph plus decision
 * points fully describe sequence, parallelism, branching, looping, and skipping.
 */
export interface WorkflowTemplate {
  readonly id: WorkflowTemplateId;
  readonly tenant: TenantScope;
  readonly name: string;
  readonly description?: string;
  readonly domain: WorkflowDomain;
  readonly version: number;

  readonly stages: readonly StageDefinition[];
  readonly transitions: readonly Transition[];
  readonly decisionPoints?: readonly DecisionPoint[];

  /** The stage work starts in. */
  readonly start: StageDefinitionId;
  /** Stages at which work is considered to have left the flow. */
  readonly terminals: readonly StageDefinitionId[];

  readonly archived?: boolean;
  readonly createdAt: string;
  readonly metadata?: Metadata;
}
