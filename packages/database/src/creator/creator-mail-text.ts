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
