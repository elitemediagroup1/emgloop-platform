/// <reference path="../html-to-text.d.ts" />
import { convert } from 'html-to-text';
import type { GmailMessageBody } from '@emgloop/shared';
import { trimQuotedHistory } from '../services/intelligence-fabric/domains/mail-read-through';

/** Transient text only. This parser never renders HTML, executes code or retrieves remote assets. */
export function creatorMailText(body: Pick<GmailMessageBody, 'text' | 'html'>): string | null {
  if (body.text?.trim()) return trimQuotedHistory(body.text) || null;
  if (!body.html?.trim()) return null;
  try {
    const text = convert(body.html.slice(0, 200_000), {
      wordwrap: false,
      limits: { maxInputLength: 200_000, maxDepth: 24 },
      selectors: [
        ...['head', 'script', 'style', 'img', 'svg', 'iframe', 'object', 'form', 'input', 'textarea', 'blockquote', '.gmail_quote', '.gmail_signature', '[hidden]'].map(selector => ({ selector, format: 'skip' })),
        { selector: 'a', options: { ignoreHref: true } },
      ],
    });
    return trimQuotedHistory(text) || null;
  } catch { return null; }
}

/** Text eligible for creator attribution; quoted history and conventional footer blocks are not evidence. */
export function creatorMailAttributionText(text: string): string {
  const out: string[] = [];
  for (const line of trimQuotedHistory(text).split('\n')) {
    if (/^\s*--\s*$/.test(line) ||
      /^\s*(?:best(?: regards)?|kind regards|regards|thank you|thanks|cheers|sincerely)[,!]?\s*$/i.test(line) ||
      /^\s*sent from my\b/i.test(line) ||
      /^\s*(?:(?:our|full|current|agency|creator|talent)\s+)*roster\s*:?\s*$/i.test(line) ||
      /^\s*our roster also includes\b/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}
