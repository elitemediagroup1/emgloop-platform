import { boundedLoopChatMessages, type LoopChatMessage } from '@emgloop/shared';
// HTTP boundary is independently tested: identity comes only from the session, never JSON.
export interface QuestionPrincipal {
  organizationId: string;
  userId: string;
}
export interface QuestionHandlerPorts {
  session(): Promise<QuestionPrincipal | null>;
  mayRead(principal: QuestionPrincipal): Promise<boolean>;
  answer(
    principal: QuestionPrincipal,
    question: string,
    options: {
      previousQuestions: string[];
      messages: LoopChatMessage[];
      page?: string;
      signal?: AbortSignal;
    },
  ): Promise<unknown>;
}
/** Netlify forwards the public host/protocol while Request.url may name its internal origin.
 * Match the exact public origin; never allow a missing, opaque or malformed Origin.
 * Uses the same trusted proxy headers as the existing web runtime.
 */
export function questionSameOrigin(request: Request): boolean {
  const raw = request.headers.get('origin');
  if (!raw || raw === 'null') return false;
  try {
    const origin = new URL(raw);
    if (origin.origin !== raw || !['http:', 'https:'].includes(origin.protocol)) return false;
    const internal = new URL(request.url);
    const host =
      request.headers.get('x-forwarded-host') || request.headers.get('host') || internal.host;
    const proto = request.headers.get('x-forwarded-proto') || internal.protocol.slice(0, -1);
    // Proxy chains/URL components are not a canonical host or protocol.
    if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host) || !['http', 'https'].includes(proto)) return false;
    const expected = new URL(`${proto}://${host}`);
    return origin.origin === expected.origin;
  } catch {
    return false;
  }
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

/** Finish before the host's 60-second limit and cancel provider attempts, including repair/fallback. */
export async function questionWithDeadline<T>(
  signal: AbortSignal,
  answer: (signal: AbortSignal) => Promise<T>,
  ms = 45000,
): Promise<T | { outcome: 'UNAVAILABLE'; reason: 'REQUEST_TIMEOUT' }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const timeout = new Promise<{ outcome: 'UNAVAILABLE'; reason: 'REQUEST_TIMEOUT' }>((resolve) => {
    cancel = () => {
      resolve({ outcome: 'UNAVAILABLE', reason: 'REQUEST_TIMEOUT' });
      controller.abort();
    };
    timer = setTimeout(cancel, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    if (signal.aborted) {
      cancel();
      return await timeout;
    }
    return await Promise.race([timeout, answer(controller.signal)]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
export async function handleLoopQuestion(
  request: Request,
  ports: QuestionHandlerPorts,
): Promise<Response> {
  try {
    const principal = await ports.session();
    if (!principal) return json({ error: 'Sign in to ask Loop.' }, 401);
    if (!(await ports.mayRead(principal)))
      return json({ error: 'You do not have access to Loop questions.' }, 403);
    if (!questionSameOrigin(request)) return json({ error: 'Invalid request origin.' }, 403);
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return json({ error: 'Expected JSON.' }, 415);
    if (!request.body) return json({ error: 'Ask a question.' }, 400);
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let raw = '',
      bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 96000) {
        await reader.cancel();
        return json({ error: 'Question is too long.' }, 413);
      }
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
    let body: {
      question?: unknown;
      previousQuestions?: unknown;
      messages?: unknown;
      page?: unknown;
    };
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Expected a JSON object.' }, 400);
    }
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof body.question !== 'string' ||
      !body.question.trim() ||
      body.question.length > 2000
    )
      return json({ error: 'Ask a question of at most 2,000 characters.' }, 400);
    return json(
      await questionWithDeadline(request.signal, (signal) =>
        ports.answer(principal, body.question as string, {
          signal,
          previousQuestions: Array.isArray(body.previousQuestions)
            ? body.previousQuestions
                .filter((q): q is string => typeof q === 'string' && q.length <= 2000)
                .slice(-4)
            : [],
          messages: boundedLoopChatMessages(body.messages),
          page: typeof body.page === 'string' ? body.page.slice(0, 200) : undefined,
        }),
      ),
    );
  } catch {
    return json(
      { error: 'Loop could not read the evidence or complete this answer. Please try again.' },
      503,
    );
  }
}
