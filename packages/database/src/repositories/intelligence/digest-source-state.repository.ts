// The inputs of the synthesis-eligibility decision for stored digests: is each digest's source live NOW,
// and does it hold evidence newer than what the digest read. Loop Intelligence, 2026-09-26.
//
// The same inputs the surfaces use (Chats: the connection's state, the content authorization and each
// conversation's latest observed activity), read once per owner and per provider. Keys and instants only.
//
//   Loop's own records (provider null)   always live; newer evidence is the producer's to notice (its
//                                         fingerprint), so none is claimed here.
//   TELEGRAM                             live = the connection is READY/CONNECTED_LIMITED AND the person's
//                                         content authorization stands; newest = the conversation's latest
//                                         observed activity (a DOMAIN rollup: any conversation's).
//   GMAIL                                live = the Google connection is CONNECTED; newest = the thread's
//                                         last message (a DOMAIN rollup: any thread's).
//   GOOGLE_CALENDAR                      live = the Google connection is CONNECTED; newest: not claimed.
//   anything else                        NOT live: an unknown source is never assumed current.
//
// AND, FOR EVERY DIGEST: whether its target has unresolved refresh work in intelligence_refresh_queue. A row
// there is by definition unresolved (completion deletes it): queued, claimed, retrying or HELD. While it
// exists Loop does not know whether the stored reading still stands, so it is not current for synthesis.
// This is what gives Loop-record (ORGANIZATION) readings a runtime freshness signal. Before the queue's
// migration there is no queue and nothing is unresolved.

import type { PrismaClient } from '@prisma/client';
import type { SynthesisSourceState } from '@emgloop/shared';

import type { IntelligenceDigestRecord } from './intelligence-digest.repository';
import { refreshQueuePresent } from './intelligence-fabric-presence';

const TELEGRAM_LIVE = ['READY', 'CONNECTED_LIMITED'];
/** Exact targets per refresh-queue query. Each target matches at most a handful of rows (one per state). */
const CHUNK = 100;
const targetKey = (scope: string, organizationId: string, userId: string | null, domain: string, subjectKind: string, subjectRef: string) => [scope, organizationId, userId ?? '', domain, subjectKind, subjectRef].join('\n');
const TELEGRAM_PREFIX = 'telegram_conversation:';
const THREAD_PREFIX = 'work_thread:';

export class DigestSourceStateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async resolve(digests: readonly IntelligenceDigestRecord[]): Promise<Map<string, SynthesisSourceState>> {
    const base = await this.resolveSources(digests);
    const unresolved = await this.unresolvedTargets(digests);
    const out = new Map<string, SynthesisSourceState>();
    for (const d of digests) {
      const s = base.get(d.id) ?? { connectionLive: false, sourceLastEvidenceAt: null };
      out.set(d.id, { ...s, refreshUnresolved: unresolved.has(targetKey(d.scope, d.organizationId, d.userId, d.domain, d.subjectKind, d.subjectRef)) });
    }
    return out;
  }

  /**
   * The supplied digests' targets that have a refresh request in any state (every queue row is unresolved
   * work). A TRUTH DECISION, so it asks about EXACTLY those targets -- one OR clause per digest, in chunks --
   * and reads every matching row: no result cap, so unrelated rows can never crowd out an answer.
   */
  private async unresolvedTargets(digests: readonly IntelligenceDigestRecord[]): Promise<Set<string>> {
    if (digests.length === 0 || !(await refreshQueuePresent(this.prisma))) return new Set();
    const targets = new Map<string, { organizationId: string; scope: string; userId: string | null; domain: string; subjectKind: string; subjectRef: string }>();
    for (const d of digests) targets.set(targetKey(d.scope, d.organizationId, d.userId, d.domain, d.subjectKind, d.subjectRef), { organizationId: d.organizationId, scope: d.scope, userId: d.userId, domain: d.domain, subjectKind: d.subjectKind, subjectRef: d.subjectRef });
    const all = [...targets.values()];
    const found = new Set<string>();
    for (let i = 0; i < all.length; i += CHUNK) {
      const rows = await this.prisma.intelligenceRefreshRequest.findMany({
        where: { OR: all.slice(i, i + CHUNK) },
        select: { scope: true, organizationId: true, userId: true, domain: true, subjectKind: true, subjectRef: true },
      });
      for (const r of rows) found.add(targetKey(r.scope, r.organizationId, r.userId, r.domain, r.subjectKind, r.subjectRef));
    }
    return found;
  }

  private async resolveSources(digests: readonly IntelligenceDigestRecord[]): Promise<Map<string, SynthesisSourceState>> {
    const out = new Map<string, SynthesisSourceState>();
    const cache = new Map<string, Promise<unknown>>();
    const once = <T>(key: string, read: () => Promise<T>): Promise<T> => {
      if (!cache.has(key)) cache.set(key, read());
      return cache.get(key) as Promise<T>;
    };
    for (const d of digests) {
      if (d.provider === null) {
        out.set(d.id, { connectionLive: true, sourceLastEvidenceAt: null });
        continue;
      }
      const userId = d.userId;
      if (!userId) {
        out.set(d.id, { connectionLive: false, sourceLastEvidenceAt: null });
        continue;
      }
      const principal = { organizationId: d.organizationId, userId };
      const who = `${d.organizationId}\n${userId}`;
      if (d.provider === 'TELEGRAM') {
        const [connection, authorization, latest] = await Promise.all([
          once(`tg-conn:${who}`, () => this.prisma.sourceConnection.findFirst({ where: { ...principal, provider: 'TELEGRAM' }, select: { state: true } })),
          once(`tg-auth:${who}`, () => this.prisma.sourceContentAuthorization.findFirst({ where: { ...principal, provider: 'TELEGRAM', revokedAt: null }, select: { authorizedAt: true } })),
          // Newer evidence is a truth input too: the EXACT conversation's latest activity (or, for the
          // domain rollup, the person's newest), never a capped scan that could miss it.
          d.subjectRef.startsWith(TELEGRAM_PREFIX)
            ? this.prisma.sourceObservation.aggregate({ where: { ...principal, provider: 'TELEGRAM', conversationKey: d.subjectRef.slice(TELEGRAM_PREFIX.length) }, _max: { occurredAt: true } })
            : once(`tg-newest:${who}`, () => this.prisma.sourceObservation.aggregate({ where: { ...principal, provider: 'TELEGRAM' }, _max: { occurredAt: true } })),
        ]);
        const live = !!connection && TELEGRAM_LIVE.includes((connection as { state: string }).state) && !!authorization;
        const last = (latest as { _max: { occurredAt: Date | null } })._max.occurredAt ?? null;
        out.set(d.id, { connectionLive: live, sourceLastEvidenceAt: last });
        continue;
      }
      if (d.provider === 'GMAIL' || d.provider === 'GOOGLE_CALENDAR') {
        const google = await once(`google:${who}`, () => this.prisma.googleConnection.findFirst({ where: principal, select: { status: true } }));
        const live = (google as { status: string } | null)?.status === 'CONNECTED';
        let last: Date | null = null;
        if (d.provider === 'GMAIL') {
          if (d.subjectRef.startsWith(THREAD_PREFIX)) {
            const t = await this.prisma.workThread.findFirst({ where: { ...principal, id: d.subjectRef.slice(THREAD_PREFIX.length) }, select: { lastMessageAt: true } });
            last = t?.lastMessageAt ?? null;
          } else {
            const t = await once(`gmail-newest:${who}`, () => this.prisma.workThread.findFirst({ where: principal, orderBy: { lastMessageAt: 'desc' }, select: { lastMessageAt: true } }));
            last = (t as { lastMessageAt: Date | null } | null)?.lastMessageAt ?? null;
          }
        }
        out.set(d.id, { connectionLive: live, sourceLastEvidenceAt: last });
        continue;
      }
      out.set(d.id, { connectionLive: false, sourceLastEvidenceAt: null });
    }
    return out;
  }
}
