// Narrow declaration for the locked converter used by creator-mail-text.
declare module 'html-to-text' {
  export function convert(html: string, options?: {
    wordwrap?: number | false;
    limits?: { maxInputLength?: number; maxDepth?: number };
    selectors?: readonly { selector: string; format?: string; options?: Readonly<Record<string, unknown>> }[];
  }): string;
}
