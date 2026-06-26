// IntelligenceRepository — Sprint 10 (Loop Intelligence Foundation).
//
// The Loop Intelligence engine: answers "What happened?", "Why did it happen?",
// and "What should happen next?" — entirely from computed Neon data.
// No LLM calls. No ML models. Pure signal aggregation and rule-based insight.
// Everything here is read-only over the existing Signal/Interaction/Booking
// primitives. Future sprints add LLM reasoning as a layer on top.


import type { PrismaClient } from '@prisma/client';
import { SignalType } from '@prisma/client';


// ---- Insight shapes -------------------------------------------------------

/** A single descriptive insight (Layer 1: what happened). */
export interface DescriptiveInsight {
  type: 'volume' | 'rate' | 'trend';
  metric: string;
  value: number;
  unit: string;
  direction: 'up' | 'down' | 'stable' | null;
  changeVsPriorPeriod: number | null;
  summary: string;
}

/** A diagnostic insight (Layer 2: why it happened). */
export interface DiagnosticInsight {
  type: 'correlation' | 'pattern' | 'anomaly';
  primarySignal: string;
  correlatedSignal?: string;
  confidence: number;
  description: string;
}

/** A prescriptive recommendation (Layer 3: what should happen next). */
export interface Recommendation {
  priority: 'high' | 'medium' | 'low';
  category: 'response_time' | 'ai_coverage' | 'pipeline' | 'churn' | 'booking';
  title: string;
  description: string;
  kpiImpacted: string;
  /** Suggested workflow action if applicable. */
  workflowSuggestion?: string;
}

/** Full intelligence report for one organization in one period. */
export interface IntelligenceReport {
  organizationId: string;
  generatedAt: string;
  period: { start: string; end: string };
  layer1_what: DescriptiveInsight[];
  layer2_why: DiagnosticInsight[];
  layer3_next: Recommendation[];
}


// ---- Repository -----------------------------------------------------------

export class IntelligenceRepository {
  constructor(private readonly prisma: PrismaClient) {}


  async generateReport(
    organizationId: string,
    start: Date,
    end: Date,
    priorStart?: Date,
    priorEnd?: Date,
  ): Promise<IntelligenceReport> {
    const ps = priorStart ?? new Date(start.getTime() - (end.getTime() - start.getTime()));
    const pe = priorEnd ?? start;

    const [
      currentSignals,
      priorSignals,
      currentInteractions,
      priorInteractions,
      bookings,
      priorBookings,
      churnSignals,
      responseSignals,
    ] = await Promise.all([
      this.prisma.signal.groupBy({
        by: ['type'],
        where: { organizationId, createdAt: { gte: start, lte: end } },
        _count: { _all: true },
      }),
      this.prisma.signal.groupBy({
        by: ['type'],
        where: { organizationId, createdAt: { gte: ps, lte: pe } },
        _count: { _all: true },
      }),
      this.prisma.interaction.count({
        where: { organizationId, occurredAt: { gte: start, lte: end } },      }),
      this.prisma.interaction.count({
        where: { organizationId, occurredAt: { gte: ps, lte: pe } },      }),
      this.prisma.booking.count({
        where: {
          organizationId,
          status: 'COMPLETED',
          createdAt: { gte: start, lte: end },
        },
      }),
      this.prisma.booking.count({
        where: {
          organizationId,
          status: 'COMPLETED',
          createdAt: { gte: ps, lte: pe },
        },
      }),
      this.prisma.signal.count({
        where: {
          organizationId,
          type: SignalType.CHURN_RISK,
          createdAt: { gte: start, lte: end },
        },
      }),
      this.prisma.signal.findMany({
        where: {
          organizationId,
          type: SignalType.RESPONSE_TIME,
          createdAt: { gte: start, lte: end },
        },
        select: { metadata: true },
      }),
    ]);

    // Build lookup maps
    const cur: Record<string, number> = {};
    for (const g of currentSignals) cur[g.type] = g._count._all;
    const pri: Record<string, number> = {};
    for (const g of priorSignals) pri[g.type] = g._count._all;

    const intentCur = cur[SignalType.INTENT] ?? 0;
    const intentPri = pri[SignalType.INTENT] ?? 0;
    const intentChange = intentPri > 0 ? ((intentCur - intentPri) / intentPri) * 100 : null;

    const interactionChange = priorInteractions > 0
      ? ((currentInteractions - priorInteractions) / priorInteractions) * 100
      : null;

    const bookingChange = priorBookings > 0
      ? ((bookings - priorBookings) / priorBookings) * 100
      : null;

    const responseTimes = responseSignals
      .map((s) => {
        const m = s.metadata as Record<string, unknown>;
        return typeof m['responseSeconds'] === 'number' ? m['responseSeconds'] : null;
      })
      .filter((v): v is number => v !== null);
    const avgResponseTime = responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : null;

    // ---- Layer 1: What happened? ------------------------------------------
    const layer1: DescriptiveInsight[] = [
      {
        type: 'volume',
        metric: 'lead_volume',
        value: intentCur,
        unit: 'leads',
        direction: intentChange === null ? null : intentChange > 0 ? 'up' : intentChange < 0 ? 'down' : 'stable',
        changeVsPriorPeriod: intentChange !== null ? Math.round(intentChange) : null,
        summary: intentChange !== null
          ? (intentCur + ' inbound leads — ' + (intentChange >= 0 ? '+' : '') + Math.round(intentChange) + '% vs prior period')
          : (intentCur + ' inbound leads this period'),
      },
      {
        type: 'volume',
        metric: 'interactions',
        value: currentInteractions,
        unit: 'interactions',
        direction: interactionChange === null ? null : interactionChange > 0 ? 'up' : interactionChange < 0 ? 'down' : 'stable',
        changeVsPriorPeriod: interactionChange !== null ? Math.round(interactionChange) : null,
        summary: currentInteractions + ' total interactions this period',
      },
      {
        type: 'rate',
        metric: 'booking_rate',
        value: intentCur > 0 ? Math.round((bookings / intentCur) * 1000) / 10 : 0,
        unit: '%',
        direction: bookingChange === null ? null : bookingChange > 0 ? 'up' : bookingChange < 0 ? 'down' : 'stable',
        changeVsPriorPeriod: bookingChange !== null ? Math.round(bookingChange) : null,
        summary: bookings + ' bookings completed this period',
      },
      ...(avgResponseTime !== null ? [{
        type: 'rate' as const,
        metric: 'avg_response_time',
        value: Math.round(avgResponseTime),
        unit: 'seconds',
        direction: null,
        changeVsPriorPeriod: null,
        summary: 'Average response time: ' + Math.round(avgResponseTime) + 's',
      }] : []),
    ];

    // ---- Layer 2: Why did it happen? -------------------------------------
    const layer2: DiagnosticInsight[] = [];

    if (churnSignals > 0 && intentCur > 0 && (churnSignals / intentCur) > 0.1) {
      layer2.push({
        type: 'correlation',
        primarySignal: 'CHURN_RISK',
        correlatedSignal: 'INTENT',
        confidence: 0.7,
        description:
          churnSignals + ' churn risk signals detected — ' +
          Math.round((churnSignals / intentCur) * 100) + '% of lead volume. ' +
          'High churn risk may indicate missed follow-ups or service quality issues.',
      });
    }

    if (avgResponseTime !== null && avgResponseTime > 900) {
      layer2.push({
        type: 'anomaly',
        primarySignal: 'RESPONSE_TIME',
        confidence: 0.85,
        description:
          'Average response time of ' + Math.round(avgResponseTime / 60) + ' minutes exceeds the 15-minute target. ' +
          'This may be causing lead drop-off and lower booking rates.',
      });
    }

    if (intentChange !== null && intentChange < -20) {
      layer2.push({
        type: 'trend',
        primarySignal: 'INTENT',
        confidence: 0.8,
        description:
          'Lead volume declined ' + Math.abs(Math.round(intentChange)) + '% vs prior period. ' +
          'Consider reviewing marketing channel performance and AI coverage.',
      });
    }

    // ---- Layer 3: What should happen next? --------------------------------
    const layer3: Recommendation[] = [];

    if (avgResponseTime !== null && avgResponseTime > 300) {
      layer3.push({
        priority: avgResponseTime > 900 ? 'high' : 'medium',
        category: 'response_time',
        title: 'Reduce response time with AI coverage',
        description:
          'Response time is averaging ' + Math.round(avgResponseTime / 60) + ' minutes. ' +
          'Activating an AI Employee for after-hours or overflow coverage can bring this below 5 minutes.',
        kpiImpacted: 'response_time + booking_rate',
        workflowSuggestion: 'Trigger auto-reply workflow on call.missed events',
      });
    }

    if (churnSignals > 2) {
      layer3.push({
        priority: 'high',
        category: 'churn',
        title: 'Re-engage high churn-risk customers',
        description:
          churnSignals + ' customers have CHURN_RISK signals. ' +
          'A follow-up workflow triggered on CHURN_RISK signals can recover these relationships.',
        kpiImpacted: 'retention + lifetime_value',
        workflowSuggestion: 'Create workflow: CHURN_RISK signal -> assign to manager for follow-up',
      });
    }

    if (bookings > 0 && intentCur > 0 && (bookings / intentCur) < 0.2) {
      layer3.push({
        priority: 'medium',
        category: 'booking',
        title: 'Improve lead-to-booking conversion',
        description:
          'Only ' + Math.round((bookings / intentCur) * 100) + '% of leads converted to bookings. ' +
          'An automated follow-up workflow on INTENT signals can nurture leads to conversion.',
        kpiImpacted: 'booking_rate + revenue',
        workflowSuggestion: 'Create workflow: INTENT signal -> schedule follow-up at +24h',
      });
    }

    return {
      organizationId,
      generatedAt: new Date().toISOString(),
      period: { start: start.toISOString(), end: end.toISOString() },
      layer1_what: layer1,
      layer2_why: layer2,
      layer3_next: layer3,
    };
  }
}
