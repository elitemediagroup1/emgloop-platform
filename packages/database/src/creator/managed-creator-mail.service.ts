import type { ManagedCreatorMailCapture } from '@prisma/client';
import { AI_OUTPUT_REJECTIONS, AI_TASK_CREATOR_BRAND_UPDATE, CREATOR_BRAND_UPDATE_SCHEMA, type GmailThreadResult } from '@emgloop/shared';
import type { GmailThreadSearchResult } from '@emgloop/providers';
import type { WorkPrincipal } from '../repositories/work-state/work-principal';
import type { AiRunRequest, AiRunResult } from '../services/ai-runtime/gateway';
import { buildMailTriageContext } from '../services/ai-runtime/mail-content-triage-context';
import { creatorCapturePolicyFailure, creatorCaptureOutputFailure } from './creator-capture-failure';
import { creatorMailText, creatorMailAttributionText } from './creator-mail-text';
import { CREATOR_BRAND_MAIL_INSTRUCTIONS } from './creator-brand-mail.service';
import { ManagedCreatorMailRepository, captureReadings } from './managed-creator-mail.repository';
import { creatorMailAliases, exactMailPhrase, companyMailDomainMatch, externalBrandCandidate, mailEvidenceHash, type ManagedCaptureReading } from './creator-mail-matching';

const INSTRUCTIONS = CREATOR_BRAND_MAIL_INSTRUCTIONS
  .replace('Interpret one explicitly owner-authorized brand email thread', 'Interpret one manager-authorized managed-mailbox brand conversation')
  .replace('SCOPE is the owner’s explicit mapping; replies need not repeat those names. Withhold if the messages contradict that mapping.', [
    'SCOPE is a provisional automatic candidate, NOT an owner-confirmed creator-brand relationship.',
    'Confirm from the messages that the named creator is the subject of the named brand partnership. A candidate domain may belong to an agency, not the advertiser. Identify the actual advertiser in brandName from substantive partnership evidence; never equate an agency domain with its client. Withhold if uncertain or several advertisers are involved.',
    'A search keyword, roster list, signature, quoted unrelated pitch or ordinary word matching a company name is not attribution evidence.',
    'An assigned mailbox is a search source, not proof that every forwarded discussion belongs to its creator.',
    'Other creators may not exist in Loop yet. Withhold their discussions even when they are absent from the supplied roster.',
    'Withhold uncertain, internal, mixed-creator or contradicted matches. Cite the actual partnership evidence.',
  ].join(' '))
  .concat('\nReturn exactly one JSON object with eight keys: schemaId, publishable, stage, summary, nextStep, citations, brandName, dealQualification. brandName is the actual advertiser explicitly supported by the correspondence, or null if uncertain. When the provisional brand is unresolved, identify the actual brand from substantive correspondence; do not treat the provisional label as a real company. No Markdown or extra keys. Paraphrase in your own words; never copy eight consecutive source words. Aim for a summary under 300 characters. citations must be an array of exact supplied mail_message sourceRef strings, at least one and at most eight when publishable.');
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
    try { return await this.step(row.refreshActive ? { ...row, pendingThreadIds: row.refreshPendingThreadIds, nextPageToken: row.refreshNextPageToken, searchComplete: row.refreshSearchComplete, listedCount: 0 } : row); }
    catch { await repo.finish(row, now(), { failure: 'CAPTURE_FAILED', delayMs: 300_000 }).catch(() => false); return { CAPTURE_WAITING: 1 }; }
  }

  private async step(row: ManagedCreatorMailCapture): Promise<Record<string, number>> {
    const { repository: repo, now, mailboxes, runtime } = this.ports;
    const principal = { organizationId: row.organizationId, userId: row.ownerUserId };
    const scope = await repo.scope(row);
    if (!scope) { await repo.finish(row, now(), { failure: 'SCOPE_ENDED', delayMs: 300_000 }); return { CAPTURE_WAITING: 1 }; }
    if (!row.pendingThreadIds.length) {
      if (row.searchComplete) {
        if (row.refreshActive) { await repo.finish(row, now(), { refreshComplete: true, delayMs: 0 }); return { CAPTURE_LISTED: 1 }; }
        await repo.finish(row, now(), { resetCycle: true, delayMs: 0 });
        return { CAPTURE_LISTED: 1 };
      }
      const query = row.query.replace(/^after:\d+\s+/, '');
      // Separate incremental cursor: refreshing never discards historical backfill progress.
      const incrementalSince = Math.floor(((row.lastRefreshAt?.getTime() ?? row.refreshStartedAt?.getTime() ?? now().getTime()) - 86400_000) / 1000);
      const page = await mailboxes.searchThreads(principal, row.mailboxId, row.refreshActive ? `after:${incrementalSince} ${query}` : query, row.nextPageToken);
      if (!page.ok) { await repo.finish(row, now(), { failure: 'SEARCH_UNAVAILABLE', delayMs: 300_000, resetCycle: false }); return { CAPTURE_WAITING: 1 }; }
      const seen = new Set(captureReadings(row.readings).filter(r => Date.parse(r.checkedAt) >= row.cycleStartedAt.getTime()).map(r => r.threadId));
      // Bound each cycle while allowing multiple Gmail result pages and a deeper backfill.
      // Finish the entire Gmail page before advancing its cursor. Truncating the page
      // at the 500-thread cycle boundary permanently skipped the remaining IDs.
      // One final page can take the cycle up to 599 IDs, still bounded.
      if (page.threadIds.length > 100) throw new Error('GMAIL_PAGE_EXCEEDS_CONTRACT');
      const ids = [...new Set(page.threadIds)].filter(id => row.refreshActive || !seen.has(id));
      const listed = row.listedCount + ids.length, capped = !!page.nextPageToken && listed >= 500;
      await repo.finish(row, now(), { pending: ids, pageToken: page.nextPageToken, refreshComplete: row.refreshActive && !page.nextPageToken && !ids.length, listed, complete: capped || !page.nextPageToken, capped, delayMs: ids.length || page.nextPageToken && !capped ? 0 : 300_000 });
      return { CAPTURE_LISTED: 1 };
    }
    const threadId = row.pendingThreadIds[0]!;
    const prior = await repo.priorReading(row, threadId);
    const cooling = prior?.state === 'MODEL_UNAVAILABLE' ? prior : undefined;
    const retryAt = Date.parse(cooling?.retryAfter ?? '');
    if (cooling && retryAt > now().getTime() && retryAt <= Date.parse(cooling.checkedAt) + 3600_000 &&
      AI_OUTPUT_REJECTIONS.some(code => Array.isArray(cooling.rejections) && cooling.rejections.includes(code))) {
      // Pop only this cycle's queue entry. Do not rewrite the reading/check time or extend its cooldown.
      const stored = await repo.finish(row, now(), { pending: row.pendingThreadIds.slice(1), delayMs: row.pendingThreadIds.length === 1 && row.searchComplete ? 300_000 : 0 });
      return stored ? { CAPTURE_CHECKED: 1, DEFERRED: 1 } : { WITHDRAWN: 1 };
    }
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
    if (!answer.ok) return finish();
    // Gmail returns whole conversations, including unsent replies. Exclude individual
    // draft/spam/trash messages before any matching, fingerprinting or AI context.
    const eligible = answer.thread.messages.filter(m => !m.fact.labels.some(l => ['SPAM', 'TRASH', 'DRAFT'].includes(l)));
    if (!eligible.length) return finish();
    const internal = new Set(scope.internalAddresses.map(a => a.toLowerCase()));
    const external = eligible.filter(m => {
      const from = m.fact.from?.address.toLowerCase();
      if (!from) return false;
      return internal.has(from) || m.fact.fromSelf ? [...m.fact.to, ...m.fact.cc].some(a => !internal.has(a.address.toLowerCase())) : true;
    });
    if (!external.length) { reading = { ...reading, state: 'WITHHELD' }; return finish(); }
    const latest = [...external].sort((a, b) => b.fact.internalDate.getTime() - a.fact.internalDate.getTime())[0]!;
    const evidenceAt = latest.fact.internalDate;
    // Do not discard older valid messages when a historical Gmail query is authorized.
    if (!Number.isFinite(evidenceAt.getTime()) || evidenceAt > now() || evidenceAt.getTime() <= 0) return finish();
    reading = { ...reading, evidenceAt: evidenceAt.toISOString(), evidenceKey: mailEvidenceHash(latest.fact.headerMessageId?.trim() || `${row.id}:${threadId}:${latest.fact.messageId}`), messageCount: external.length, incomplete: external.length > 12 || external.some(m => m.body.truncated || (m.body.text?.length ?? 0) > 1500 || !m.body.text?.trim() && !!m.body.html) };
    if (!creatorMailText(latest.body)) return finish();
    const human = external.filter(m => !m.fact.automationClass).sort((a, b) => a.fact.internalDate.getTime() - b.fact.internalDate.getTime());
    // Include more chronological context, retaining a bounded gateway input budget.
    // Historical cross-thread synthesis and paginated backfill are tracked separately in #423.
    const messages = human.slice(-12).flatMap(m => {
      const raw = creatorMailText(m.body) ?? '';
      const substantive = creatorMailAttributionText(raw);
      if (substantive !== raw) reading = { ...reading, incomplete: true };
      const text = substantive.slice(0, 1500);
      return text ? [{ direction: (internal.has(m.fact.from?.address.toLowerCase() ?? '') || m.fact.fromSelf ? 'OUTBOUND' : 'INBOUND') as 'OUTBOUND' | 'INBOUND', occurredAt: m.fact.internalDate, fromLabel: null, text }] : [];
    });
    if (!messages.length) { reading = { ...reading, state: 'WITHHELD' }; return finish(); }
    const subject = latest.fact.subject ?? '';
    const text = `${subject}\n${messages.map(m => m.text).join('\n')}`;
    const matches = scope.roster.filter(p => creatorMailAliases(p).some(alias => exactMailPhrase(text, alias)));
    if (matches.some(p => p.id !== row.creatorProfileId)) { reading = { ...reading, state: 'MIXED_CREATORS' }; return finish(); }
    // Shared inboxes match the saved creator name/handle in the subject OR substantive body.
    // Signatures, roster footers and quoted history cannot supply the match; AI still confirms it.
    if (scope.source.kind === 'STAFF' && !creatorMailAliases(scope.profile).some(alias => exactMailPhrase(text, alias))) { reading = { ...reading, state: 'UNMATCHED_CREATOR' }; return finish(); }
    const participants = external.flatMap(m => [m.fact.from, ...m.fact.to, ...m.fact.cc].flatMap(a => a && !internal.has(a.address.toLowerCase()) ? [a.address] : []));
    // Never match a company from ordinary body words. An exact company/domain correspondence
    // is another provisional candidate, not confirmation of a creator-brand relationship.
    const brands = scope.brands.filter(b => b.displayName && b.displayName.trim().length >= 4 && (exactMailPhrase(subject, b.displayName) || companyMailDomainMatch(b.displayName, participants)));
    const candidate = brands.length === 0 ? externalBrandCandidate(participants) : null;
    if (brands.length > 1 || (!brands.length && !candidate && !/\b(?:partnership|collaborat\w*|sponsor\w*|campaign|deliverables?|influencer|brand)\b/i.test(text))) { reading = { ...reading, state: 'UNMAPPED_BRAND' }; return finish(); }
    const brand = brands[0];
    const brandName = brand?.displayName ?? candidate ?? 'UNRESOLVED_ADVERTISER';
    const classificationVersion = !prior || prior.classificationVersion === 10 || ['NEGOTIATING', 'CONFIRMED'].includes(prior.update?.stage ?? '') ? 10 : 9;
    reading = { ...reading, classificationVersion, brandId: brand?.id ?? null, ...(candidate ? { candidateBrandName: candidate } : {}), fingerprint: mailEvidenceHash(JSON.stringify({ template: classificationVersion, creator: row.creatorProfileId, brand: brand?.id ?? candidate, messages, incomplete: reading.incomplete })) };
    const previous = prior?.fingerprint === reading.fingerprint && ['CURRENT', 'WITHHELD'].includes(prior.state) ? prior : undefined;
    if (previous) { reading = { ...previous, evidenceAt: reading.evidenceAt, evidenceKey: reading.evidenceKey, checkedAt: now().toISOString() }; return finish(0, false, true); }
    const contextId = mailEvidenceHash(`${row.id}:${threadId}`);
    if (!(await repo.scope(row))) { await repo.finish(row, now(), { failure: 'SCOPE_ENDED', delayMs: 300_000 }); return { CAPTURE_WAITING: 1 }; }
    const built = buildMailTriageContext({ ...principal, organizationId: row.organizationId, viewerUserId: row.ownerUserId, threadId: contextId, subject, messages, truncated: reading.incomplete, lane: null });
    const authority = { resource: 'managedMailboxes', action: 'view' as const };
    const context = { ...built.context, taskId: AI_TASK_CREATOR_BRAND_UPDATE.taskId, items: [...built.context.items.map(item => ({ ...item, readUnder: authority })), { blockId: `${row.organizationId}::creator_scope:${row.id}`, kind: 'TEXT' as const, trust: 'UNTRUSTED_INPUT' as const, sourceRef: `creator_scope:${row.id}`, content: `SCOPE: creator=${JSON.stringify(scope.profile.displayName)}; provisional advertiser=${JSON.stringify(brandName)}; external participant domains=${JSON.stringify([...new Set(participants.map(p => p.split('@')[1]))].slice(0, 12))}; source=${scope.source.kind === 'CREATOR' ? 'assigned creator mailbox' : 'shared staff mailbox'}; evidence ${reading.incomplete ? 'is incomplete' : 'is included'}.`, sensitivity: 'CONTACT_IDENTIFIER' as const, readUnder: authority }] };
    const request: AiRunRequest = { task: AI_TASK_CREATOR_BRAND_UPDATE, context, evidence: built.evidence, instructions: `${INSTRUCTIONS}\nReview date: ${now().toISOString().slice(0, 10)}.`, schema: CREATOR_BRAND_UPDATE_SCHEMA, templateId: 'managed-creator-brand-mail', templateVersion: '10', signal: AbortSignal.timeout(45_000) };
    let result = await runtime.run(principal, request);
    // At most one validation repair, with original evidence only. Refusals/failures stop.
    // Each run uses the governed gateway and its own reservation; rejected prose is never fed back.
    if (result.outcome === 'REJECTED_OUTPUT' && !request.signal?.aborted) {
      const codes = AI_OUTPUT_REJECTIONS.filter(code => result.outcome === 'REJECTED_OUTPUT' && result.rejections.includes(code)).slice(0, 8);
      if (codes.length) {
        if (!(await repo.scope(row))) { await repo.finish(row, now(), { failure: 'SCOPE_ENDED', delayMs: 300_000 }); return { CAPTURE_WAITING: 1 }; }
        if (!request.signal?.aborted) result = await runtime.run(principal, {
          ...request, templateVersion: '10.repair1',
          instructions: `${request.instructions}\nOne validation repair. Previous validation codes: ${codes.join(', ')}. Generate a fresh response from the supplied source evidence. Do not copy source sentences or invent facts to satisfy validation. Use short paraphrases, no numbers, dates, quotes or private commercial details. Cite exact supplied mail_message references only. If a safe, attributable summary is not possible, use publishable false with empty summary, nextStep and citations.`,
        });
      }
    }
    if (result.outcome !== 'ANSWERED' || !result.output.creatorBrandUpdate) {
      // Closed internal codes only: no provider error prose or rejected output.
      modelFailure = result.outcome === 'REFUSED_BY_LOOP' ? creatorCapturePolicyFailure(result.refusals)
        : result.outcome === 'REJECTED_OUTPUT' ? creatorCaptureOutputFailure(result.rejections)
        : result.outcome === 'REFUSED_BY_MODEL' ? 'MODEL_REFUSED'
        : result.outcome === 'FAILED' ? 'MODEL_CALL_FAILED' : 'MODEL_OUTPUT_INVALID';
      reading = { ...reading, state: 'MODEL_UNAVAILABLE' };
      if (result.outcome === 'REJECTED_OUTPUT') {
        const rejections = AI_OUTPUT_REJECTIONS.filter(code => result.rejections.includes(code));
        if (rejections.length) {
          reading = { ...reading, retryAfter: new Date(now().getTime() + 3600_000).toISOString(), rejections };
          const stored = await repo.finish(row, now(), { reading, pending: row.pendingThreadIds.slice(1),
            delayMs: row.pendingThreadIds.length === 1 && row.searchComplete ? 300_000 : 0, failure: modelFailure });
          return stored ? { CAPTURE_CHECKED: 1, NOT_PUBLISHED: 1 } : { WITHDRAWN: 1 };
        }
      }
      return finish(3600_000, true);
    }
    const update = result.output.creatorBrandUpdate;
    const resolved = update.brandName?.trim();
    const normalizeBrand = (name: string) => name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (update.publishable && resolved) {
      const known = scope.brands.find(b => b.displayName && normalizeBrand(b.displayName) === normalizeBrand(resolved));
      const grounded = !!known && known.id === brand?.id || candidate && normalizeBrand(candidate) === normalizeBrand(resolved) || exactMailPhrase(text, resolved);
      if (!grounded) { reading = { ...reading, state: 'UNMAPPED_BRAND' }; return finish(); }
      reading = { ...reading, brandId: known?.id ?? null, candidateBrandName: known ? undefined : resolved };
    } else if (update.publishable && (update.brandName === null || !brand && !candidate)) {
      reading = { ...reading, state: 'UNMAPPED_BRAND' }; return finish();
    }
    reading = { ...reading, state: update.publishable ? 'CURRENT' : 'WITHHELD', update, generatedAt: update.publishable ? now().toISOString() : null };
    return finish();
  }
}
