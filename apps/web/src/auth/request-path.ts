import 'server-only';
import { headers } from 'next/headers';

/**
 * The path and query of the page being rendered, as forwarded by the middleware
 * (x-pathname, x-search). Used so a guard that finds no session can send the
 * person to login carrying exactly what they asked for.
 */
export function requestedPath(): string | undefined {
  const h = headers();
  const pathname = h.get('x-pathname');
  return pathname ? pathname + (h.get('x-search') ?? '') : undefined;
}
