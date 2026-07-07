/**
 * Work OS - External Domain Links
 *
 * A WorkItem can attach to any other Loop domain: Brain activity, a Marketplace
 * campaign, a CRM record, a Creator, a Business. Critically, the Work OS does
 * NOT import those domains' types. Doing so would couple the execution engine
 * to every product and create duplication. Instead each link is a neutral
 * reference: a domain tag + an opaque id + an optional label.
 *
 * This is the seam that keeps Work OS universal and provider-neutral.
 *
 * Pure contracts only.
 */

import type { ExternalId } from "./identifiers";

/**
 * The Loop domains a WorkItem can be linked to. Adding a future product means
 * adding a member here, never importing a new package. "custom" is the escape
 * hatch for domains not yet enumerated, keeping the model open-ended.
 */
export const LINK_DOMAINS = [
  "brain",
  "marketplace",
  "crm",
  "creator",
  "business",
  "integration",
  "project",
  "custom",
] as const;
export type LinkDomain = (typeof LINK_DOMAINS)[number];

/** How a WorkItem relates to the linked external entity. */
export const LINK_RELATIONS = [
  "about",
  "caused_by",
  "affects",
  "references",
  "source",
  "target",
] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

/**
 * A neutral, one-directional pointer from a WorkItem to an entity in another
 * domain. `entityType` is a free string (e.g. "campaign", "buyer", "recommendation")
 * owned by the target domain, not by Work OS. `entityId` is opaque. No target
 * domain type is imported, so there is zero duplication with Brain, Marketplace
 * or CRM.
 */
export interface DomainLink {
  readonly domain: LinkDomain;
  /** Domain-owned subtype string. Work OS does not enumerate these. */
  readonly entityType: string;
  readonly entityId: ExternalId;
  readonly relation: LinkRelation;
  /** Optional denormalized label for display only. Never authoritative. */
  readonly label?: string;
}

/** Convenience shape: a WorkItem's full set of outward domain links. */
export type DomainLinkSet = readonly DomainLink[];
