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

import type { PrismaClient } from '@prisma/client';
import type { SynthesisSourceState } from '@emgloop/shared';

import type { IntelligenceDigestRecord } from './intelligence-digest.repository';

const TELEGRAM_LIVE = ['READY', 'CONNECTED_LIMITED'];
const TELEGRAM_PREFIX = 'telegram_conversation:';
const THREAD_PREFIX = 'work_thread:';

export class DigestSourceStateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async resolve(digests: readonly IntelligenceDigestRecord[]): Promise<Map<string, SynthesisSourceState>> {
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
          once(`tg-latest:${who}`, async () => {
            const rows = await this.prisma.sourceObservation.findMany({ where: { ...principal, provider: 'TELEGRAM' }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 500, select: { conversationKey: true, occurredAt: true } });
            const byKey = new Map<string, Date>();
            for (const r of rows) if (!byKey.has(r.conversationKey)) byKey.set(r.conversationKey, r.occurredAt);
            return { byKey, newest: rows[0]?.occurredAt ?? null };
          }),
        ]);
        const live = !!connection && TELEGRAM_LIVE.includes((connection as { state: string }).state) && !!authorization;
        const l = latest as { byKey: Map<string, Date>; newest: Date | null };
        const last = d.subjectRef.startsWith(TELEGRAM_PREFIX) ? (l.byKey.get(d.subjectRef.slice(TELEGRAM_PREFIX.length)) ?? null) : l.newest;
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
