// Home reads each of its sources on its own: a source that throws becomes "could not read this just
// now" in its own panel, and the rest of Home renders. (A Home that read one missing table directly
// was a production outage on 2026-09-18.)
//
// Next.js signals redirect, notFound and dynamic rendering by THROWING. Those are never "a source
// failed" -- swallowing a redirect would render a page the guard meant to leave -- so they pass
// through untouched.

function isControlFlow(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && /^(NEXT_REDIRECT|NEXT_NOT_FOUND|DYNAMIC_SERVER_USAGE)/.test(digest);
}

export type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

export async function settle<T>(load: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await load() };
  } catch (error) {
    if (isControlFlow(error)) throw error;
    return { ok: false };
  }
}
