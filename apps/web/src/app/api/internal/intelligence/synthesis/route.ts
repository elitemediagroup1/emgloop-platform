import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import {
  BriefingComposer,
  SituationService,
  DomainFactsRepository,
  parseActingUsers,
  principalResolver,
  prisma,
} from '@emgloop/database';
import { AI_TASK_LOOP_BRIEFING } from '@emgloop/shared';
import { governedGateway } from '../../../../../ai/governed-gateway';
import { synthesisRecipient } from '../../../../../intelligence/synthesis-recipient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// Bounded continuation of the existing scheduler, not another intelligence implementation.
// No org or user is accepted from HTTP. Candidate principals come from the existing governed stores.
export async function POST(request: Request): Promise<Response> {
  const expected = process.env.INTELLIGENCE_MAIL_SECRET ?? '';
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (
    !expected ||
    !supplied ||
    Buffer.byteLength(expected) !== Buffer.byteLength(supplied) ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
  )
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (process.env.LOOP_INTELLIGENCE_WEB_SYNTHESIS !== 'on')
    return NextResponse.json({ ok: true, outcome: 'NOT_ACTIVATED' });
  const phase = new URL(request.url).searchParams.get('phase') ?? 'briefing';
  const { env, gateway, authorize } = governedGateway();
  const modelEnabled = (taskId: string) =>
    env.activation.enabled && env.activation.tasks.includes(taskId);
  const now = () => new Date();
  const composer = new BriefingComposer({ prisma, runtime: gateway, modelEnabled, now });
  const people = (await composer.people(now(), 200))
    .filter((p) => env.activation.organizations.includes(p.organizationId));
  if (!people.length) return NextResponse.json({ ok: true, outcome: 'NO_PRINCIPALS' });
  const rawSlot = Number(new URL(request.url).searchParams.get('slot') ?? '0');
  if (!Number.isInteger(rawSlot) || rawSlot < 0 || rawSlot > 199)
    return NextResponse.json({ error: 'invalid slot' }, { status: 400 });
  const person = synthesisRecipient(people, phase, now().getTime(), rawSlot)!;
  const principal = { organizationId: person.organizationId, userId: person.userId };
  if (phase === 'briefing') {
    if (!modelEnabled('loop.briefing.compose'))
      return NextResponse.json({ ok: true, outcome: 'TASK_NOT_ACTIVATED' });
    if (!(await authorize(principal, AI_TASK_LOOP_BRIEFING)))
      return NextResponse.json({ ok: true, outcome: 'NOT_AUTHORIZED' });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, 45000);
    request.signal.addEventListener('abort', cancel, { once: true });
    try {
      if (request.signal.aborted) cancel();
      const bounded = new BriefingComposer({
        prisma,
        runtime: gateway,
        modelEnabled,
        now,
        signal: controller.signal,
      });
      return NextResponse.json({
        ok: true,
        ...(await bounded.compose(principal, person.timeZone)),
      });
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', cancel);
    }
  }
  if (phase !== 'organization' && phase !== 'private')
    return NextResponse.json({ error: 'invalid phase' }, { status: 400 });
  const resolve = principalResolver(
    new DomainFactsRepository(prisma),
    parseActingUsers(process.env.LOOP_INTELLIGENCE_ACTING_USERS ?? ''),
    now,
  );
  const situations = new SituationService({
    prisma,
    runtime: gateway,
    modelEnabled,
    now,
    principalFor: (owner) =>
      resolve(
        owner.scope === 'PRINCIPAL'
          ? { ...owner, domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain' }
          : { ...owner, domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain' },
      ),
  });
  const owner =
    phase === 'private'
      ? { scope: 'PRINCIPAL' as const, ...principal }
      : { scope: 'ORGANIZATION' as const, organizationId: person.organizationId };
  // Diagnosis explains the first evidence gate even when there is no model invocation to inspect.
  const diagnosis = await situations.diagnose(owner);
  // At most one cluster per web request so author + independent verifier fit the request deadline.
  const report = await situations.pass(owner, 1);
  return NextResponse.json({ ok: true, phase, diagnosis, report });
}
