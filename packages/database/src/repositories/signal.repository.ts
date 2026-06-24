// SignalRepository — Sprint 4 (Real Data Layer).
//
// Signals are the platform's append-only, soft-intelligence layer (intent,
// churn risk, sentiment, ...). The loop writes coarse signals like
// "lead.received" and "message.inbound"; the repository maps each to the
// schema's SignalType enum + machine `key`, storing the raw label/payload so
// nothing is lost when richer models arrive later.

import type { PrismaClient, Signal, SignalType } from '@prisma/client';
import type { CreateSignalInput } from './types';

/**
 * Map the loop's free-form signal label to a SignalType enum value. Unknown
 * labels fall back to CUSTOM, preserving the original label in `key`.
 */
export function signalTypeFromLabel(label: string): SignalType {
  const l = label.toLowerCase();
  if (l.includes('lead') || l.includes('intent') || l.includes('inbound'))
    return 'INTENT';
  if (l.includes('churn')) return 'CHURN_RISK';
  if (l.includes('upsell')) return 'UPSELL_OPPORTUNITY';
  if (l.includes('sentiment')) return 'SENTIMENT';
  if (l.includes('no_show') || l.includes('noshow')) return 'NO_SHOW_RISK';
  return 'CUSTOM';
}

export class SignalRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(input: CreateSignalInput): Promise<Signal> {
    return this.prisma.signal.create({
      data: {
        organizationId: input.organizationId,
        customerId: input.customerId ?? null,
        conversationId: input.conversationId ?? null,
        type: input.type,
        key: input.key,
        label: input.label ?? null,
        valueNumber: input.valueNumber ?? null,
        valueString: input.valueString ?? null,
        confidence: input.confidence ?? null,
        source: input.source ?? null,
        metadata: (input.metadata ?? {}) as object,
      },
    });
  }

  /**
   * Convenience: record a signal from the loop's coarse label, deriving the
   * SignalType automatically and keeping the label as the machine key.
   */
  record(args: {
    organizationId: string;
    customerId?: string | null;
    label: string;
    payload?: Record<string, unknown>;
    source?: string | null;
  }): Promise<Signal> {
    return this.create({
      organizationId: args.organizationId,
      customerId: args.customerId ?? null,
      type: signalTypeFromLabel(args.label),
      key: args.label,
      label: args.label,
      source: args.source ?? null,
      metadata: args.payload ?? {},
    });
  }

  listForCustomer(customerId: string): Promise<Signal[]> {
    return this.prisma.signal.findMany({
      where: { customerId },
      orderBy: { observedAt: 'desc' },
    });
  }
}
