/**
 * @emgloop/work-os
 *
 * Canonical domain model for the Loop Work OS: the execution engine of Loop.
 *
 * This package is CONTRACTS ONLY. It contains no runtime logic, no persistence,
 * no UI, no workflow/task engine, no automations, and no Brain execution. It
 * defines the universal shapes that let every part of the company answer:
 * what do I do next, why is it next, what is blocked, who receives this after
 * me, what am I waiting on, and what is the highest priority.
 *
 * The Brain determines priorities. The Work OS models how they are executed.
 *
 * See README.md for the full architectural reasoning.
 */

// Identifiers (branded ids for every entity)
export * from "./identifiers";

// Universal primitives (status, priority, timing)
export * from "./primitives";

// Actors, ownership, assignment, watchers
export * from "./actors";

// Outward links to Brain / Marketplace / CRM / Creator / Business
export * from "./links";

// Collaboration surfaces (comment, checklist, attachment)
export * from "./collaboration";

// Relationships, dependencies, blocking
export * from "./relationships";

// Activity and notifications (Work-OS scoped)
export * from "./activity";

// Governance (approvals, decisions)
export * from "./governance";

// The universal WorkItem
export * from "./work-item";

// Task alias over WorkItem
export * from "./task";

// Structural containers (workspace, project, workflow, stage, milestone, queue)
export * from "./structure";
