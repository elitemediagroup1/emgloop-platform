// @emgloop/brain — Revenue Intelligence.
//
// Sprint 12: architecture for Revenue Events. The Brain should eventually
// understand WHAT created revenue, not merely that money moved. This file
// distinguishes a raw Payment from a higher-order Revenue Event and the many
// revenue categories the platform must reason about. No payment provider is
// integrated in Sprint 12; these are contracts only.

import type { Confidence, Metadata } from './types';

/** A raw money-movement record (e.g. from a future payment provider). */
export interface Payment {
  id?: string;
  organizationId: string;
  externalId: string;
  amountCents: number;
  currency: string;
  occurredAt: Date;
  metadata?: Metadata;
}

/** The categories of revenue the Brain attributes. */
export type RevenueEventType =
  | 'revenue_event'
  | 'commission'
  | 'affiliate'
  | 'lead_sale'
  | 'agency_revenue'
  | 'marketplace_revenue'
  | 'creator_revenue'
  | 'revenue_opportunity'
  | 'revenue_loss';

/** A higher-order revenue event, attributed to its cause. */
export interface RevenueEvent {
  id?: string;
  organizationId: string;
  type: RevenueEventType;
  /** Net amount in cents; may be negative for revenue_loss. */
  amountCents: number;
  currency: string;
  occurredAt: Date;
  /** The raw payment this derives from, if any. */
  paymentId?: string;
  /** Subject (customer/identity) credited with the revenue. */
  subjectId?: string;
  /** Signal keys / interactions the Brain believes CAUSED this revenue. */
  attribution: RevenueAttribution[];
  confidence: Confidence;
  metadata?: Metadata;
}

/** A single attribution link explaining why revenue happened. */
export interface RevenueAttribution {
  /** What drove it: 'signal' | 'interaction' | 'campaign' | 'creator' | ... */
  kind: string;
  ref: string;
  weight: number; // 0..1 share of attribution
  reason: string;
}

/** Contract for the revenue intelligence service. Deterministic in Sprint 12. */
export interface RevenueIntelligence {
  /** Promote a raw payment into an attributed revenue event. */
  attribute(payment: Payment): Promise<RevenueEvent>;
  /** Record a non-payment revenue event (lead sale, commission, loss, ...). */
  record(event: Omit<RevenueEvent, 'id'>): Promise<RevenueEvent>;
}
