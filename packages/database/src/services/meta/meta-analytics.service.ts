import { createHash } from 'crypto';
import { AI_TASK_CREATOR_ANALYTICS_READING, DOMAIN_READING_SCHEMA, aiNumbersInText, type AiContextPackage, type AiSupportedEvidence } from '@emgloop/shared';
import type { MetaReport } from '@emgloop/providers';
import { MetaConnectionRepository, type MetaPrincipal } from '../../repositories/meta-connection.repository';
import type { AiRuntimeGateway } from '../ai-runtime/gateway';
export function metaAnalyticsFingerprint(rows: readonly { report: unknown }[]) {
  return createHash('sha256').update(JSON.stringify(rows.map(row => row.report))).digest('hex');
}
export function metaAnalyticsContext(p: MetaPrincipal, rows: readonly { id: string; observedAt: Date; report: unknown }[]): { context: AiContextPackage; evidence: AiSupportedEvidence } {
  const figures = new Map<string, Set<number>>(), dates = new Set<string>();
  const items = rows.map(row => {
    const report = row.report as MetaReport;
    const sourceRef = `meta_observation:${row.id}`;
    dates.add(row.observedAt.toISOString().slice(0, 10)); dates.add(report.windowStart.slice(0, 10)); dates.add(report.windowEnd.slice(0, 10));
    // Names, captions, URLs, account ids and tokens are not model context. Media keys are sample ordinals.
    const content = JSON.stringify({ platform: report.platform, observedAt: row.observedAt.toISOString(), windowStart: report.windowStart, windowEnd: report.windowEnd, followers: report.followers, accountMetrics: report.metrics, recentContent: report.media.map((m, index) => ({ sampleIndex: index + 1, type: m.type, publishedAt: m.publishedAt, lifetimeMetrics: m.metrics })), limitations: report.limitations });
    figures.set(sourceRef, new Set(aiNumbersInText(content)));
    for (const media of report.media) if (media.publishedAt) dates.add(media.publishedAt.slice(0, 10));
    return { blockId: `${p.organizationId}::${sourceRef}`, kind: 'TEXT' as const, trust: 'UNTRUSTED_INPUT' as const, sourceRef, content, sensitivity: 'OPERATIONAL' as const, readUnder: { resource: 'ownCreatorProfile', action: 'view' as const } };
  });
  return { context: { organizationId: p.organizationId, viewerUserId: p.userId, taskId: AI_TASK_CREATOR_ANALYTICS_READING.taskId, sensitivityCeiling: 'OPERATIONAL', items }, evidence: { figures, dates, terms: new Set() } };
}
export class MetaAnalyticsService {
  constructor(private readonly repository: MetaConnectionRepository, private readonly gateway: Pick<AiRuntimeGateway, 'run'>) {}
  async analyze(p: MetaPrincipal): Promise<string> {
    const claimed = await this.repository.claimAnalysis(p);
    if (!claimed) return 'NOT_DUE';
    const { connection, observations, leaseId } = claimed;
    try {
      const fingerprint = metaAnalyticsFingerprint(observations);
      if (!observations.length || await this.repository.reading(p, fingerprint)) {
        await this.repository.finishAnalysis(p, connection.id, leaseId, { failure: observations.length ? 'UNCHANGED' : 'NO_EVIDENCE' });
        return observations.length ? 'UNCHANGED' : 'NO_EVIDENCE';
      }
      const built = metaAnalyticsContext(p, observations);
      const result = await this.gateway.run({ organizationId: p.organizationId, userId: p.userId }, { task: AI_TASK_CREATOR_ANALYTICS_READING, ...built, instructions: 'Analyze only these creator-owned Meta numerical observations. Return domain-reading.v1 with a concise performance reading, cited OBSERVATION or INFERENCE signals, and explicit limitations. Suggest practical next experiments as hypotheses. Use supplied sourceRefs for every signal. Do not claim real-time source updates, causation, audience demographics, retention, hooks or topics you cannot see. Do not combine account views and lifetime media views or sum reach across days. Recent content is a small age-biased sample; do not equate it with window totals. Missing is unknown, never zero. Do not invent percentages, ratios, dates, facts or numbers. No tools or actions. Use no entities, obligations or deadlines.', schema: DOMAIN_READING_SCHEMA, templateId: 'creator-meta-analytics', templateVersion: '1', lane: 'BACKGROUND' });
      if (result.outcome !== 'ANSWERED' || !result.output.domainReading) {
        await this.repository.finishAnalysis(p, connection.id, leaseId, { failure: result.outcome });
        return result.outcome;
      }
      const saved = await this.repository.finishAnalysis(p, connection.id, leaseId, { fingerprint, observationIds: observations.map(r => r.id), evidenceAt: new Date(Math.max(...observations.map(r => +r.observedAt))), reading: result.output.domainReading, invocationId: result.provenance.invocationId, providerId: result.provenance.requestedModel.providerId });
      return saved ? 'ANALYZED' : 'WITHDRAWN';
    } catch {
      await this.repository.finishAnalysis(p, connection.id, leaseId, { failure: 'UNAVAILABLE' });
      return 'UNAVAILABLE';
    }
  }
}
