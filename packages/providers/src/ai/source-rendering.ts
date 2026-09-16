// How supplied evidence is written into a model request. Slice AI-3.
//
// ONE RENDERING, FOR EVERY PROVIDER. Both adapters send the same text, so a claim
// about what a model was shown means the same thing whichever model answered.
//
// SOURCE CONTENT IS DATA, NEVER INSTRUCTION. Evidence can contain text somebody typed,
// and text somebody typed can say "ignore your instructions". So every block is
// wrapped in an element whose boundaries the content cannot forge: `<`, `>` and `&`
// inside content are escaped, so no source can close its own element, open another,
// or impersonate the wrapper. The instructions (the reviewed template) tell the model
// that everything inside `<loop_sources>` is untrusted material to explain, not to
// obey -- and even a model that obeyed would find nothing to act with: no task at
// launch publishes a tool, and none may publish one that writes.
//
// PURE.

import type { AiContentBlock } from '@emgloop/shared';

export const AI_SOURCES_OPEN = '<loop_sources>';
export const AI_SOURCES_CLOSE = '</loop_sources>';

/** Escapes the three characters that could forge or break an element boundary. */
export function escapeAiSourceText(text: string): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attribute(value: string): string {
  return escapeAiSourceText(value).replace(/"/g, '&quot;');
}

export function renderAiSources(blocks: readonly AiContentBlock[]): string {
  const body = blocks.map(
    (block) =>
      `<source ref="${attribute(block.sourceRef)}" trust="${attribute(block.trust)}" kind="${attribute(block.kind)}">\n` +
      `${escapeAiSourceText(block.content)}\n` +
      `</source>`,
  );
  return [AI_SOURCES_OPEN, ...body, AI_SOURCES_CLOSE].join('\n');
}
