import { CopyIntakeSummary } from '../../../../../intake/CopyIntakeSummary';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { absentUntilMigrated } from '@emgloop/database';
import {
  readIntakeTemplate,
  intakeContent,
  INTAKE_STATE_LABELS,
  type IntakeState,
} from '@emgloop/shared';
import { hasPermission, requirePermission } from '../../../../../auth/guard';
import { qualificationIntakes } from '../../../../../intake/intake-runtime';
import { IntakeEditor } from '../../../../../intake/IntakeEditor';
import { IntakeContentView } from '../../../../../intake/intake-content-view';
import { viewerTime } from '../../../../../time/viewer-time';
import { LoopPage, PageHead, StateBlock } from '../../../_loop-os/record';
export const dynamic = 'force-dynamic';
export default async function IntakeRecordPage({
  params,
  searchParams,
}: {
  params: { intakeId: string };
  searchParams?: { saved?: string };
}) {
  const session = await requirePermission('intakes', 'view');
  await requirePermission('identityResolution', 'view');
  const repo = qualificationIntakes();
  const read = await absentUntilMigrated(
    repo
      .read(session.organizationId, session.userId, params.intakeId)
      .then((record) => ({ record })),
  );
  if (!read)
    return (
      <LoopPage label="Intake">
        <StateBlock
          kind="unavailable"
          title="Intakes are not available on this deployment."
          body="The intake database migration is required."
        />
      </LoopPage>
    );
  const record = read.record;
  if (!record) notFound();
  const template = readIntakeTemplate(record.templateSnapshot),
    content = intakeContent(record.revisions[0]?.content);
  if (!template || !content)
    return (
      <LoopPage label="Intake">
        <StateBlock
          kind="error"
          title="This saved intake could not be read."
          body="Its saved questions and revisions have been retained. Contact your administrator."
        />
      </LoopPage>
    );
  const options = await repo.options(session.organizationId, session.userId);
  const canUpdate = await hasPermission('intakes', 'update'),
    canApprove = await hasPermission('intakes', 'approve'),
    time = viewerTime();
  return (
    <LoopPage label="Intake record">
      <PageHead
        trail={[
          { label: 'CRM' },
          { label: 'Intake & Qualification', href: '/app/crm/intakes' },
          { label: content.title },
        ]}
        title={content.title}
        subtitle={`${template.engagement} · ${template.label} · Template v${record.templateVersion}`}
        actions={
          <span className="loop-pill">{INTAKE_STATE_LABELS[record.state as IntakeState]}</span>
        }
      />
      {searchParams?.saved ? (
        <p role="status" className="iq-notice">
          Saved as revision {record.currentRevision}.
        </p>
      ) : null}
      <div className="iq-context">
        <strong>{record.party?.displayName ?? 'Linked identity'}</strong>
        <Link href={`/app/crm/intakes?party=${record.partyId}`}>All intakes for this identity</Link>
        {record.opportunity ? (
          <Link href={`/app/crm/opportunities/${record.opportunity.id}`}>
            {record.opportunity.title}
          </Link>
        ) : (
          <span>
            {record.opportunityId ? 'Linked opportunity is unavailable' : 'No opportunity linked'}
          </span>
        )}
        {record.creatorProfile && (await hasPermission('work', 'update')) ? (
          <Link href={`/app/admin/creator-hub/${record.creatorProfile.id}`}>
            Creator profile and contact details
          </Link>
        ) : null}
      </div>
      <section className="loop-panel iq-section">
        <h2>Qualification handoff</h2>
        <p>{template.outputs.join(' · ')}</p>
        <p className="loop-note">
          Qualification records a manager’s readiness decision. Prepare the linked commercial and
          delivery work through Loop’s existing opportunity and Work OS controls.
        </p>
      </section>
      <CopyIntakeSummary
        text={[
          content.title,
          `${template.engagement} · ${template.label}`,
          record.party?.displayName ?? 'CRM identity',
          ...template.fields.map((f) => `${f.label}\n${content.answers[f.id] || 'Not recorded'}`),
          `Decision-maker\n${record.contactNames.find((p) => p.id === content.decisionMakerPartyId)?.displayName ?? 'Not recorded'}`,
          `Unresolved issues\n${content.unresolvedIssues || 'Not recorded'}`,
          `Action owner\n${record.staffNames.find((p) => p.id === content.nextActionOwnerUserId)?.name ?? 'Not recorded'}`,
          `Next step\n${content.nextStep || 'Not recorded'}`,
          `Due date\n${content.dueDate || 'Not recorded'}`,
          `Checkpoint\n${content.checkpoint || 'Not recorded'}`,
        ].join('\n\n')}
      />
      {canUpdate && options ? (
        <IntakeEditor
          template={template}
          identities={options.identities}
          owners={options.owners}
          content={content}
          partyId={record.partyId}
          record={{
            id: record.id,
            revision: record.currentRevision,
            state: record.state as IntakeState,
          }}
          canApprove={canApprove}
          opportunities={await repo.opportunities(
            session.organizationId,
            session.userId,
            record.partyId,
          )}
        />
      ) : (
        <IntakeContentView
          template={template}
          content={content}
          names={record.contactNames}
          owners={record.staffNames}
        />
      )}
      <section className="loop-panel iq-section">
        <h2>Revision history</h2>
        {record.revisions.map((revision) => {
          const previous = intakeContent(revision.content);
          return (
            <details className="iq-history" key={revision.id}>
              <summary>
                Revision {revision.number} · {INTAKE_STATE_LABELS[revision.state as IntakeState]} ·{' '}
                {time.dateTime(revision.createdAt)} ·{' '}
                {record.staffNames.find((u) => u.id === revision.recordedByUserId)?.name ??
                  'Staff member'}
              </summary>
              {previous ? (
                <IntakeContentView
                  template={template}
                  content={previous}
                  names={record.contactNames}
                  owners={record.staffNames}
                />
              ) : (
                <p>This revision could not be read.</p>
              )}
            </details>
          );
        })}
      </section>
    </LoopPage>
  );
}
