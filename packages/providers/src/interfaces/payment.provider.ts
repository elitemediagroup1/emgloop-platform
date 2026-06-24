// Payment provider interface.
//
// Abstracts payment processors (Stripe first, others later). The platform never
// stores raw card data — it works with provider tokens / intents only.

import type { BaseProvider, ProviderContext } from '../types';

export interface Money {
  /** Minor units, e.g. cents. */
  amount: number;
  currency: string; // ISO 4217
}

export interface CreatePaymentIntentRequest {
  amount: Money;
  /** Reference back to an Order or Booking in our system. */
  referenceType?: 'order' | 'booking' | 'service_request' | 'other';
  referenceId?: string;
  description?: string;
  /** Provider customer token, if one exists. */
  customerToken?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface PaymentIntent {
  externalId: string;
  status: 'requires_action' | 'processing' | 'succeeded' | 'canceled' | 'failed';
  /** Client secret / token used by the front-end to complete payment. */
  clientToken?: string;
  amount: Money;
}

export interface RefundRequest {
  paymentExternalId: string;
  amount?: Money; // omit for full refund
  reason?: string;
  idempotencyKey?: string;
}

export interface RefundResult {
  externalId: string;
  status: 'pending' | 'succeeded' | 'failed';
}

export interface PaymentProvider extends BaseProvider {
  createPaymentIntent(
    ctx: ProviderContext,
    req: CreatePaymentIntentRequest,
  ): Promise<PaymentIntent>;
  refund(ctx: ProviderContext, req: RefundRequest): Promise<RefundResult>;
  verifyWebhook?(
    ctx: ProviderContext,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<boolean>;
}
