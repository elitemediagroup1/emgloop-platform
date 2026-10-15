import { LoopQuestionService, gmailMailReadThrough, prisma, repositories } from '@emgloop/database';
import { getSession } from '../../../../auth/auth';
import { governedGateway } from '../../../../ai/governed-gateway';
import { handleLoopQuestion } from '../../../../ai/loop-question-handler';
import { GMAIL_CONFIG } from '../../../../daily-loop/mail';
import { BUSINESS_TIME_ZONE } from '@emgloop/shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleLoopQuestion(request, {
    session: async () => {
      const s = await getSession();
      return s ? { organizationId: s.organizationId, userId: s.userId } : null;
    },
    mayRead: (principal) =>
      repositories.iam.can({ ...principal, resource: 'employeeIntelligence', action: 'view' }),
    answer: (principal, question, options) =>
      new LoopQuestionService(prisma, governedGateway().gateway, () => new Date(), {
        governanceDecision: process.env.LOOP_MAIL_CONTENT_GOVERNANCE_DECISION,
        readMailThread: gmailMailReadThrough(prisma, GMAIL_CONFIG()),
      }).answer(principal, question, {
        ...options,
        timeZone: BUSINESS_TIME_ZONE,
      }),
  });
}

/** Safe commissioning check: activation lists and credential presence, never secret values. */
export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (
    !(await repositories.iam.can({
      organizationId: session.organizationId,
      userId: session.userId,
      resource: 'employeeIntelligence',
      action: 'view',
    }))
  )
    return Response.json({ error: 'forbidden' }, { status: 403 });
  const { env } = governedGateway();
  return Response.json(
    {
      runtimeEnabled: env.activation.enabled,
      organizationEnabled: env.activation.organizations.includes(session.organizationId),
      tasks: env.activation.tasks,
      providers: env.configuration,
      webSynthesisEnabled: process.env.LOOP_INTELLIGENCE_WEB_SYNTHESIS === 'on',
      note: 'Configuration only. Successful recorded provider calls are required to prove operation.',
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
