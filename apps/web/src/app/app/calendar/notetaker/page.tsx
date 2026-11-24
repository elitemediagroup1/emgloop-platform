import { redirect } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@emgloop/database';
import { ownCaptures, scheduleCapture } from '../../../../notetaker/capture';
import { audioRecording, captureConfigured, recallBotStatus, recallRequest, validBotId } from '../../../../notetaker/recall';
import WorkspaceShell from '../../../../workspaces/WorkspaceShell';
import { LoopPage, PageHead } from '../../_loop-os/record';
import { captureDate, captureTitle, notetakerBookerNames, requireNotetaker, notetakerTimeZone, notetakerPath as path } from './meeting-display';

const messages: Record<string, string> = {
  scheduled: 'The Notetaker was requested.',
  invalid: 'Enter a Google Meet, Zoom, Microsoft Teams, or Webex join link.',
  duplicate: 'A Notetaker is already scheduled for this link.',
  unknown: 'The capture provider did not confirm the request. Check the bot status before retrying.',
  updated: 'The Notetaker status was refreshed.',
  failed: 'The capture provider is unavailable or the bot has not joined yet.',
};
const statuses: Record<string, string> = {
  submitting: 'Awaiting provider confirmation',
  scheduled: 'Scheduled',
  joining_call: 'Joining',
  in_waiting_room: 'Waiting for admission',
  in_call_not_recording: 'In call · recording off',
  in_call_recording: 'Recording',
  recording_requested: 'Starting recording',
  call_ended: 'Call ended',
  done: 'Finished',
  fatal: 'Unable to join or record',
};

async function addCapture(form: FormData) {
  'use server';
  const principal = await requireNotetaker('update');
  const outcome = captureConfigured()
    ? await scheduleCapture(principal, String(form.get('meetingUrl') ?? '').trim(), { title: String(form.get('title') ?? '') })
    : 'failed';
  redirect(path + '?result=' + outcome);
}

async function controlCapture(form: FormData) {
  'use server';
  const principal = await requireNotetaker('update');
  const capture = await prisma.meetingCapture.findFirst({
    where: { ...ownCaptures(principal), id: String(form.get('id') ?? '') },
  });
  const botId = capture?.providerBotId;
  const action = form.get('action');
  if (!capture || !validBotId(botId)) redirect(path + '?result=failed');
  let result = 'failed';
  try {
    const bot = await recallRequest(botId + '/', 'GET');
    const state = recallBotStatus(bot);
    if (typeof state === 'string' && Object.hasOwn(statuses, state)) {
      if (action === 'refresh' && capture.status !== 'recording_requested') {
        await prisma.meetingCapture.update({ where: { id: capture.id }, data: { status: state } });
        result = 'updated';
      }
      if (action === 'refresh' && capture.status === 'recording_requested' && state !== 'in_call_not_recording') {
        await prisma.meetingCapture.update({ where: { id: capture.id }, data: { status: state } });
        result = 'updated';
      }
      if (action === 'start' && form.get('consent') === 'yes' && state === 'in_call_not_recording') {
        const claimed = await prisma.meetingCapture.updateMany({
          where: { id: capture.id, status: 'in_call_not_recording' }, data: { status: 'recording_requested' },
        });
        if (claimed.count) {
          await recallRequest(botId + '/start_recording/', 'POST', audioRecording);
          result = 'updated';
        }
      }
      if (action === 'stop' && state === 'in_call_recording') {
        await recallRequest(botId + '/stop_recording/', 'POST');
        result = 'updated';
      }
    }
  } catch {
    // Keep provider response bodies and meeting links out of user-facing errors.
  }
  redirect(path + '?result=' + result);
}

export default async function NotetakerPage({ searchParams }: { searchParams: { result?: string } }) {
  const session = await requireNotetaker('view');
  const configured = captureConfigured();
  const [captures, timeZone] = await Promise.all([
    prisma.meetingCapture.findMany({
      where: ownCaptures(session), orderBy: { createdAt: 'desc' }, take: 30,
      select: { id: true, meetingUrl: true, status: true, providerBotId: true, title: true, meetingAt: true, createdAt: true },
    }),
    notetakerTimeZone(session),
  ]);
  const bookerNames = await notetakerBookerNames(session, captures);
  const result = searchParams.result;
  return (
    <WorkspaceShell session={session}>
      <LoopPage label="Notetaker">
        <PageHead trail={[{ label: 'Calendar', href: '/app/calendar' }]} title="Notetaker" />
        {result && Object.hasOwn(messages, result) && <p role="status">{messages[result]}</p>}
        <p>For bookings that match your event settings, the Notetaker starts recording audio when it joins. Confirm participants agree before admitting it.</p>
        <a href="/app/calendar/booking">Manage when Notetaker joins bookings</a>
        {configured ? (
          <details>
          <summary>Add Notetaker to an outside meeting</summary>
          <form action={addCapture}>
            <label>Meeting name <input name="title" maxLength={160} /></label>
            <label>Meeting link <input type="url" name="meetingUrl" maxLength={2048} required /></label>
            <button type="submit">Add Notetaker</button>
          </form>
          </details>
        ) : <p>Meeting capture provider setup is pending.</p>}
        <ul className="loop-panel">
          {captures.map(capture => (
            <li key={capture.id}>
              <p><Link href={`${path}/${capture.id}`} prefetch={false}>
                <strong>{captureTitle(capture, bookerNames.get(capture.id))}</strong> · <time dateTime={(capture.meetingAt ?? capture.createdAt).toISOString()}>{captureDate(capture, timeZone)}</time>
              </Link> · {statuses[capture.status]}</p>
              {configured && capture.providerBotId && capture.status !== 'done' && (
                <form action={controlCapture}>
                  <input type="hidden" name="id" value={capture.id} />
                  <button type="submit" name="action" value="refresh" formNoValidate>Refresh status</button>
                  {capture.status === 'in_call_not_recording' && (
                    <>
                      <label><input type="checkbox" name="consent" value="yes" required /> Everyone has agreed to audio recording.</label>
                      <button type="submit" name="action" value="start">Start audio capture</button>
                    </>
                  )}
                  {capture.status === 'in_call_recording' && <button type="submit" name="action" value="stop">Stop audio capture</button>}
                </form>
              )}
            </li>
          ))}
        </ul>
      </LoopPage>
    </WorkspaceShell>
  );
}
