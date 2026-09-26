// The Mail producers' read-through: a person's OWN Gmail thread, read through their own connection by
// the same governed read the thread view performs (`readEmployeeGmailThread`), reduced to what mail
// content triage needs, and kept nowhere. Loop Intelligence Phase E, 2026-09-26.
//
// The thread is resolved by Loop's own row WITHIN the person's scope first -- a thread id that is not
// theirs is not found, never read. Bodies are plain text with quoted history trimmed and capped; HTML
// is never passed on. Nothing here writes.

import type { PrismaClient } from '@prisma/client';

import type { MailTriageMessage } from '../../ai-runtime/mail-content-triage-context';
import { readEmployeeGmailThread, type EmployeeGmailConfig } from '../../work-state/gmail-sync-runtime';
import type { MailThreadRead } from './mail';

const MAX_MESSAGES = 20;
const MAX_TEXT_CHARS = 4000;

/** Drop quoted history: `>` lines, and everything from an "On ... wrote:" attribution onwards. */
export function trimQuotedHistory(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*On .{3,200}wrote:\s*$/.test(line) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^\s*From: .+/.test(line) && out.length > 0) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT_CHARS);
}

export function gmailMailReadThrough(prisma: PrismaClient, config: EmployeeGmailConfig) {
  return async (principal: { organizationId: string; userId: string }, loopThreadId: string): Promise<MailThreadRead | null> => {
    const row = await prisma.workThread.findFirst({ where: { id: loopThreadId, organizationId: principal.organizationId, userId: principal.userId }, select: { threadId: true, subject: true } });
    if (!row) return null;
    const result = await readEmployeeGmailThread(config, principal, row.threadId);
    if (!result.ok) return null;
    const all = result.thread.messages;
    const kept = all.slice(-MAX_MESSAGES);
    const messages: MailTriageMessage[] = kept.flatMap((m) => {
      const text = m.body.text ? trimQuotedHistory(m.body.text) : '';
      if (!text) return [];
      return [{ direction: m.fact.fromSelf ? 'OUTBOUND' : 'INBOUND', occurredAt: m.fact.internalDate, fromLabel: m.fact.fromSelf ? null : (m.fact.from?.name ?? null)?.slice(0, 80) ?? null, text }];
    });
    return { subject: row.subject, messages, truncated: kept.length < all.length || kept.some((m) => m.body.truncated) };
  };
}
