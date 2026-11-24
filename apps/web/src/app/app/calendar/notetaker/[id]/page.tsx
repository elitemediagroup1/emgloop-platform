import { notFound } from 'next/navigation';
import { prisma } from '@emgloop/database';
import { ownCaptures } from '../../../../../notetaker/capture';
import WorkspaceShell from '../../../../../workspaces/WorkspaceShell';
import { LoopPage, PageHead, Panel } from '../../../_loop-os/record';
import { captureDate, captureTitle, notetakerBookerNames, notetakerPath, notetakerTimeZone, requireNotetaker } from '../meeting-display';
import { MeetingNotesLoader } from './MeetingNotesLoader';

export default async function MeetingNotesPage({ params }: { params: { id: string } }) {
  const session = await requireNotetaker('view');
  const [capture, timeZone] = await Promise.all([
    prisma.meetingCapture.findFirst({ where: { id: params.id, ...ownCaptures(session) } }),
    notetakerTimeZone(session),
  ]);
  if (!capture) notFound();
  const bookerNames = await notetakerBookerNames(session, [capture]);
  const title = captureTitle(capture, bookerNames.get(capture.id));
  const finished = capture.status === 'done';
  const needsNotes = capture.transcript === null || (!!capture.transcript && !capture.summary);

  return (
    <WorkspaceShell session={session}>
      <LoopPage label={title}>
        <PageHead
          trail={[{ label: 'Calendar', href: '/app/calendar' }, { label: 'Notetaker', href: notetakerPath }, { label: title }]}
          title={title}
          subtitle={captureDate(capture, timeZone)}
        />
        <Panel title="Meeting summary">
          {capture.summary ? <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{capture.summary}</p> :
            finished && needsNotes ? <MeetingNotesLoader id={capture.id} /> :
              <p>{!finished ? 'Meeting notes are available after the recording finishes.' : 'The recording had no transcribed speech.'}</p>}
        </Panel>
        {capture.transcript && (
          <details className="loop-panel">
            <summary className="loop-panel__title">Full transcript</summary>
            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{capture.transcript}</div>
          </details>
        )}
      </LoopPage>
    </WorkspaceShell>
  );
}
