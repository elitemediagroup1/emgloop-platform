import { prisma } from '@emgloop/database';
import { recallRequest, validBotId, recallBotStatus } from '../../../../../notetaker/recall';
import { verifyWebhook } from '../../../../../notetaker/verify-webhook';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const secret = process.env.RECALL_US_EAST_WEBHOOK_SECRET;
  if (!secret) return new Response(null, { status: 503 });
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > 65_536) return new Response(null, { status: 413 });
  if (!verifyWebhook(request.headers, raw, secret)) return new Response(null, { status: 401 });

  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { return new Response(null, { status: 400 }); }
  const botId = event?.data?.bot?.id;
  if (!validBotId(botId) || typeof event.event !== 'string' || !event.event.startsWith('bot.')) {
    return new Response(null, { status: 204 });
  }
  const capture = await prisma.meetingCapture.findUnique({
    where: { providerBotId: botId }, select: { id: true, status: true },
  });
  if (!capture) return new Response(null, { status: 204 });

  // Recall retries deliveries. Use the current bot state even for an older notification.
  const status = recallBotStatus(await recallRequest(botId + '/', 'GET'));
  if (status && !(capture.status === 'recording_requested' && status === 'in_call_not_recording')) {
    await prisma.meetingCapture.updateMany({
      where: { id: capture.id, status: capture.status }, data: { status },
    });
  }
  return new Response(null, { status: 204 });
}
