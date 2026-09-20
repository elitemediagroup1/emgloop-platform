// Reading the connection outcome a redirect carried back to the page. Presentation only: an
// unknown value is ignored, and nothing here decides anything.

import { isConnectionActionOutcome, isConnectionProvider, type ConnectionActionOutcome, type ConnectionProvider } from '@emgloop/shared';

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
