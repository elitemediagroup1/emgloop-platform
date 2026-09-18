// Reading an email as text. PURE -- no DOM, no parser, no network.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6.12 (GM-2).
//
// LOOP RENDERS MAIL AS TEXT, AND ONLY AS TEXT. An email body is attacker-controlled markup: it
// can carry script, event handlers, styles that escape their container, forms that post
// somewhere else, and images whose only purpose is to report that it was opened. Loop renders
// none of it. A message's `text/plain` part is shown as text; a message that carried only HTML is
// reduced to text HERE, server-side, and the result is still rendered as text.
//
// THAT IS A PRODUCT DECISION, NOT A LIMITATION TO FIX LATER. Rendering somebody's marketing email
// pixel-perfectly is not what Loop is for, and the cost of doing it is an iframe, a sanitizer and
// a tracking-pixel policy. Reading and answering business correspondence needs the words.

/** Entities common enough in mail that leaving them encoded would be visible to a reader. */
const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
});

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d{1,7});/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * The readable text of an HTML email.
 *
 * Whole elements whose CONTENT is not prose -- script, style, head, and the rest -- are removed
 * with their contents, rather than having their tags stripped and their source left behind as
 * text. Block boundaries become line breaks so paragraphs survive. Everything else that looks
 * like markup is removed, so nothing that reaches a reader can still be markup.
 */
export function mailTextFromHtml(html: string): string {
  const withoutBlocks = html.replace(/<(script|style|head|noscript|template|svg|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const withBreaks = withoutBlocks
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|blockquote|table|section|article)\s*>/gi, '\n')
    .replace(/<\s*(p|div|tr|li|h[1-6]|blockquote|table|section|article)\b[^>]*>/gi, '\n');
  const withoutTags = withBreaks.replace(/<[^>]*>/g, ' ');
  return decodeEntities(withoutTags)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * What a reader sees for one message: its own text, or its HTML reduced to text, or nothing.
 *
 * Nothing is a real answer: a message whose only content is an image or an attachment has no
 * words, and inventing some would be worse than saying so.
 */
export function mailReadableText(message: { readonly text: string | null; readonly html: string | null }): string | null {
  const plain = message.text?.trim();
  if (plain) return plain;
  const html = message.html?.trim();
  if (!html) return null;
  const text = mailTextFromHtml(html);
  return text === '' ? null : text;
}

/**
 * The quoted history at the end of a reply, cut off.
 *
 * A reply usually repeats the entire conversation beneath it, which Loop is already showing
 * above. Cutting it makes a thread readable; it is presentation only, and the full text is one
 * click away in the reader's own mail client.
 */
export function mailWithoutQuotedTail(text: string): { readonly body: string; readonly quotedLines: number } {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    const isQuoteHeader =
      /^on .{6,120}wrote:$/i.test(line) ||
      /^-{2,}\s*original message\s*-{2,}$/i.test(line) ||
      /^_{5,}$/.test(line) ||
      /^from:\s.+/i.test(line);
    if (isQuoteHeader && i > 0) {
      return { body: lines.slice(0, i).join('\n').trimEnd(), quotedLines: lines.length - i };
    }
  }
  const firstQuoted = lines.findIndex((l) => l.trimStart().startsWith('>'));
  if (firstQuoted > 0) return { body: lines.slice(0, firstQuoted).join('\n').trimEnd(), quotedLines: lines.length - firstQuoted };
  return { body: text, quotedLines: 0 };
}
