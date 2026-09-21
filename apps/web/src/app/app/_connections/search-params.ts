// Reading the connection outcome a redirect carried back to the page. Presentation only: an
// unknown value is ignored, and nothing here decides anything.

import { isConnectionActionOutcome, isConnectionProvider, isSourceBaselineActionOutcome, isSourceContentActionOutcome, type ConnectionActionOutcome, type ConnectionProvider, type SourceBaselineActionOutcome, type SourceContentActionOutcome } from '@emgloop/shared';

export type PageSearchParams = { readonly [key: string]: string | string[] | undefined } | undefined;

function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

export function connectionOutcomeParam(searchParams: PageSearchParams): ConnectionActionOutcome | null {
  const value = single(searchParams?.connection);
  return isConnectionActionOutcome(value) ? value : null;
}

export function connectionProviderParam(searchParams: PageSearchParams): ConnectionProvider | null {
  const value = single(searchParams?.provider);
  return isConnectionProvider(value) ? value : null;
}

export function baselineOutcomeParam(searchParams: PageSearchParams): SourceBaselineActionOutcome | null {
  const value = single(searchParams?.baseline);
  return isSourceBaselineActionOutcome(value) ? value : null;
}

export function contentOutcomeParam(searchParams: PageSearchParams): SourceContentActionOutcome | null {
  const value = single(searchParams?.content);
  return isSourceContentActionOutcome(value) ? value : null;
}
