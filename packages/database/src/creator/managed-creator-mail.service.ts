import type { ManagedCreatorMailCapture } from '@prisma/client';
import { AI_TASK_CREATOR_BRAND_UPDATE, CREATOR_BRAND_UPDATE_SCHEMA, type GmailThreadResult } from '@emgloop/shared';
import type { GmailThreadSearchResult } from '@emgloop/providers';
import type { WorkPrincipal } from '../repositories/work-state/work-principal';
import type { AiRunRequest, AiRunResult } from '../services/ai-runtime/gateway';
import { buildMailTriageContext } from '../services/ai-runtime/mail-content-triage-context';
import { trimQuotedHistory } from '../services/intelligence-fabric/domains/mail-read-through';
import { CREATOR_BRAND_MAIL_INSTRUCTIONS } from './creator-brand-mail.service';
import { ManagedCreatorMailRepository, captureReadings } from './managed-creator-mail.repository';
import { creatorMailAliases, exactMailPhrase, mailEvidenceHash, type ManagedCaptureReading } from './creator-mail-matching';

const INSTRUCTIONS = CREATOR_BRAND_MAIL_INSTRUCTIONS
  .replace('Interpret one explicitly owner-authorized brand email thread', 'Interpret one manager-authorized managed-mailbox brand conversation')
  .replace('SCOPE is the owner’s explicit mapping; replies need not repeat those names. Withhold if the messages contradict that mapping.', [
    'SCOPE is a provisional automatic candidate, NOT an owner-confirmed creator-brand relationship.',
    'Confirm from the messages that the named creator is the subject of the named brand partnership.',
    'A search keyword, roster list, signature, quoted unrelated pitch or ordinary word matching a company name is not attribution evidence.',
    'An assigned mailbox is a search source, not proof that every forwarded discussion belongs to its creator.',
    'Other creators may not exist in Loop yet. Withhold their discussions even when they are absent from the supplied roster.',
    'Withhold uncertain, internal, mixed-creator or contradicted matches. Cite the actual partnership evidence.',
  ].join(' '));
export class ManagedCreatorMailService {
  constructor(private readonly ports: {
    repository: ManagedCreatorMailRepository;
    mailboxes: {
      searchThreads(principal: WorkPrincipal, mailboxId: string, query: string, pageToken?: string | null): Promise<GmailThreadSearchResult>;
      readThread(principal: WorkPrincipal, mailboxId: string, threadId: string): Promise<GmailThreadResult>;
    };
    runtime: { run(principal: WorkPrincipal, request: AiRunRequest): Promise<AiRunResult> };
    now(): Date;
  }) {}

  async pass(principal?: WorkPrincipal, profileId?: string): Promise<Record<string, number>> {
    const repo = this.ports.repository, now = this.ports.now;
    const target = (await repo.due(now(), principal, profileId))[0];
    if (!target) return {};
    const row = await repo.claim({ organizationId: target.organizationId, userId: target.ownerUserId }, target.id, now());
    if (!row) return {};
    try { return await this.step(row); }
    catch { await repo.finish(row, now(), { failure: 'CAPTURE_FAILED', delayMs: 300_000 }).catch(() => false); return { CAPTURE_WAITING: 1 }; }
  }

  private async step(row: ManagedCreatorMailCapture): Promise<Record<string, number>> {
    const { repository: repo, now, mailboxes, runtime } = this.ports;
    const principal = { organizationId: row.organizationId, userId: row.ownerUserId };
    const scope = await repo.scope(row);
    if (!scope) { await repo.finish(row, now(), { failure: 'SCOPE_ENDED', delayMs: 300_000 }); return { CAPTURE_WAITING: 1 }; }
    if (!row.pendingThreadIds.length) {
      if (row.searchComplete) {
        await repo.finish(row, now(), { resetCycle: true, delayMs: 0 });
        return { CAPTURE_LISTED: 1 };
      }
      const page = await mailboxes.searchThreads(principal, row.mailboxId, row.query, row.nextPageToken);
      if (!page.ok) { await repo.finish(row, now(), { failure: 'SEARCH_UNAVAILABLE', delayMs: 300_000, resetCycle: !!row.nextPageToken }); return { CAPTURE_WAITING: 1 }; }
      const seen = new Set(captureReadings(row.readings).filter(r => Date.parse(r.checkedAt) >= row.cycleStartedAt.getTime()).map(r => r.threadId));
      const room = Math.max(0, 100 - row.listedCount), ids = [...new Set(page.threadIds)].filter(id => !seen.has(id)).slice(0, room);
      const listed = row.listedCount + ids.length, capped = !!page.nextPageToken && listed >= 100;
      await repo.finish(row, now(), { pending: ids, pageToken: capped ? null : page.nextPageToken, listed, complete: capped || !page.nextPageToken, capped, delayMs: ids.length || page.nextPageToken && !capped ? 0 : 300_000 });
      return { CAPTURE_LISTED: 1 };
    }
    const threadId = row.pendingThreadIds[0]!;
    const checked = now();
    let reading: ManagedCaptureReading = { threadId, brandId: null, evidenceKey: mailEvidenceHash(`${row.id}:${threadId}`), fingerprint: '', evidenceAt: null, checkedAt: checked.toISOString(), generatedAt: null, messageCount: 0, incomplete: false, state: 'SOURCE_UNAVAILABLE' };
    let modelFailure = 'MODEL_UNAVAILABLE';
    const finish = async (delayMs = 0, keepPending = false, unchanged = false): Promise<Record<string, number>> => {
      const end = !keepPending && row.pendingThreadIds.length === 1 && row.searchComplete;
      const stored = await repo.finish(row, now(), { reading, pending: keepPending ? row.pendingThreadIds : row.pendingThreadIds.slice(1), delayMs: delayMs || (end ? 300_000 : 0), failure: keepPending ? modelFailure : null });
      if (!stored) return { WITHDRAWN: 1 };
      if (keepPending) return { CAPTURE_WAITING: 1, NOT_PUBLISHED: 1 };
      return { CAPTURE_CHECKED: 1, [unchanged ? 'UNCHANGED' : reading.state === 'CURRENT' ? 'PUBLISHED' : reading.state === 'SOURCE_UNAVAILABLE' ? 'SOURCE_UNAVAILABLE' : 'WITHHELD']: 1 };
    };
    const answer = await mailboxes.readThread(principal, row.mailboxId, threadId);
    if (!answer.ok || !answer.thread.messages.length || answer.thread.messages.some(m => m.fact.labels.some(l => ['SPAM', 'TRASH', 'DRAFT'].includes(l)))) return finish();
    const internal = new Set(scope.internalAddresses.map(a => a.toLowerCase()));
    const external = answer.thread.messages.filter(m => {
      const from = m.fact.from?.address.toLowerCase();
      if (!from) return false;
      return internal.has(from) || m.fact.fromSelf ? [...m.fact.to, ...m.fact.cc].some(a => !internal.has(a.address.toLowerCase())) : true;
    });
    if (!external.length) { reading = { ...reading, state: 'WITHHELD' }; return finish(); }
    const latest = [...external].sort((a, b) => b.fact.internalDate.getTime() - a.fact.internalDate.getTime())[0]!;
    const evidenceAt = latest.fact.internalDate;
    if (!Number.isFinite(evidenceAt.getTime()) || evidenceAt > now() || now().getTime() - evidenceAt.getTime() > 30 * 86400_000) return finish();
    reading = { ...reading, evidenceAt: evidenceAt.toISOString(), evidenceKey: mailEvidenceHash(latest.fact.headerMessageId?.trim() || `${row.id}:${threadId}:${latest.fact.messageId}`), messageCount: external.length, incomplete: external.length > 8 || external.some(m => m.body.truncated || (m.body.text?.length ?? 0) > 1800) };
    if (!latest.body.text || !trimQuotedHistory(latest.body.text)) return finish();
    const human = external.filter(m => !m.fact.automationClass);
    const messages = human.slice(-8).flatMap(m => {
      const text = m.body.text ? trimQuotedHistory(m.body.text).slice(0, 1800) : '';
      return text ? [{ direction: (internal.has(m.fact.from?.address.toLowerCase() ?? '') || m.fact.fromSelf ? 'OUTBOUND' : 'INBOUND') as 'OUTBOUND' | 'INBOUND', occurredAt: m.fact.internalDate, fromLabel: null, text }] : [];
    });
    if (!messages.length) { reading = { ...reading, state: 'WITHHELD' }; return finish(); }
    const subject = latest.fact.subject ?? '';
    const text = `${subject}\n${messages.map(m => m.text).join('\n')}`;
    const matches = scope.roster.filter(p => creatorMailAliases(p).some(alias => exactMailPhrase(text, alias)));
    if (matches.some(p => p.id !== row.creatorProfileId)) { reading = { ...reading, state: 'MIXED_CREATORS' }; return finish(); }
    // Staff keywords discover candidates across a shared inbox. Auto attribution additionally
    // requires the intended creator in the subject; a footer/body hit cannot bind another creator's thread.
    // Generic subjects remain eligible for explicit manager-authorized thread sharing instead.
    if (scope.source.kind === 'STAFF' && !creatorMailAliases(scope.profile).some(alias => exactMailPhrase(subject, alias))) { reading = { ...reading, state: 'UNMATCHED_CREATOR' }; return finish(); }
    const subjectBrands = scope.brands.filter(b => b.displayName && b.displayName.trim().length >= 4 && exactMailPhrase(subject, b.displayName));
    // Body words (e.g. "going to have to pass") are not canonical company references.
    // Conservative auto capture uses subject candidates only; the model must still confirm relevance.
    const brands = subjectBrands;
    if (brands.length !== 1) { reading = { ...reading, state: 'UNMAPPED_BRAND' }; return finish(); }
    const brand = brands[0]!;
    reading = { ...reading, brandId: brand.id, fingerprint: mailEvidenceHash(JSON.stringify({ template: 4, creator: row.creatorProfileId, brand: brand.id, messages, incomplete: reading.incomplete })) };
    const previous = captureReadings(row.readings).find(r => r.threadId === threadId && r.fingerprint === reading.fingerprint && ['CURRENT', 'WITHHELD'].includes(r.state));
    if (previous) { reading = { ...previous, evidenceAt: reading.evidenceAt, evidenceKey: reading.evidenceKey, checkedAt: now().toISOString() }; return finish(0, false, true); }
    const contextId = mailEvidenceHash(`${row.id}:${threadId}`);
    if (!(await repo.scope(row))) { await repo.finish(row, now(), { failure: 'SCOPE_ENDED', delayMs: 300_000 }); return { CAPTURE_WAITING: 1 }; }
    const built = buildMailTriageContext({ ...principal, organizationId: row.organizationId, viewerUserId: row.ownerUserId, threadId: contextId, subject, messages, truncated: reading.incomplete, lane: null });
    const authority = { resource: 'managedMailboxes', action: 'view' as const };
    const context = { ...built.context, taskId: AI_TASK_CREATOR_BRAND_UPDATE.taskId, items: [...built.context.items.map(item => ({ ...item, readUnder: authority })), { blockId: `${row.organizationId}::creator_scope:${row.id}`, kind: 'TEXT' as const, trust: 'UNTRUSTED_INPUT' as const, sourceRef: `creator_scope:${row.id}`, content: `SCOPE: creator=${JSON.stringify(scope.profile.displayName)}; brand or agency=${JSON.stringify(brand.displayName)}; source=${scope.source.kind === 'CREATOR' ? 'assigned creator mailbox' : 'shared staff mailbox'}; evidence ${reading.incomplete ? 'is incomplete' : 'is included'}.`, sensitivity: 'CONTACT_IDENTIFIER' as const, readUnder: authority }] };
    const result = await runtime.run(principal, { task: AI_TASK_CREATOR_BRAND_UPDATE, context, evidence: built.evidence, instructions: INSTRUCTIONS, schema: CREATOR_BRAND_UPDATE_SCHEMA, templateId: 'managed-creator-brand-mail', templateVersion: '4' });
    if (result.outcome !== 'ANSWERED' || !result.output.creatorBrandUpdate) {
      // Closed internal codes only: no provider error prose or rejected output.
      modelFailure = result.outcome === 'REFUSED_BY_LOOP' ? 'MODEL_POLICY_REFUSED'
        : result.outcome === 'REJECTED_OUTPUT' ? 'MODEL_OUTPUT_REJECTED'
        : result.outcome === 'REFUSED_BY_MODEL' ? 'MODEL_REFUSED'
        : result.outcome === 'FAILED' ? 'MODEL_CALL_FAILED' : 'MODEL_OUTPUT_INVALID';
      reading = { ...reading, state: 'MODEL_UNAVAILABLE' };
      return finish(3600_000, true);
    }
    const update = result.output.creatorBrandUpdate;
    reading = { ...reading, state: update.publishable ? 'CURRENT' : 'WITHHELD', update, generatedAt: update.publishable ? now().toISOString() : null };
    return finish();
  }
}
