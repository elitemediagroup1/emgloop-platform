import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { INTAKE_TEMPLATES, intakeTemplate, type IntakeContent } from '@emgloop/shared';
import { absentUntilMigrated } from '@emgloop/database';
import { requirePermission } from '../../../../../auth/guard';
import { qualificationIntakes } from '../../../../../intake/intake-runtime';
import { IntakeEditor } from '../../../../../intake/IntakeEditor';
import { LoopPage, PageHead, StateBlock } from '../../../_loop-os/record';
export const dynamic = 'force-dynamic';
export default async function NewIntakePage({
  searchParams,
}: {
  searchParams?: { template?: string; subtype?: string; party?: string; q?: string };
}) {
  const session = await requirePermission('intakes', 'create');
  await requirePermission('identityResolution', 'view');
  const repo = qualificationIntakes();
  const template = intakeTemplate(searchParams?.template ?? '', searchParams?.subtype ?? '');
  const options = await repo.options(
    session.organizationId,
    session.userId,
    template && !searchParams?.party ? searchParams?.q : '',
  );
  const party = searchParams?.party
    ? await repo.subject(session.organizationId, session.userId, searchParams.party)
    : null;
  const available = await absentUntilMigrated(
    repo.list(session.organizationId, session.userId, { page: 1 }),
  );
  const base = '/app/crm/intakes/new';
  const url = (key: string, subtype: string, partyId?: string) =>
    `${base}?${new URLSearchParams({ template: key, subtype, ...(partyId ? { party: partyId } : {}) })}`;
  const content: IntakeContent = {
    opportunityId: null,
    title: `${template?.engagement ?? 'Intake'} — ${party?.displayName ?? 'CRM record'}`,
    relationshipRoles: [
      template?.key === 'CREATOR_REPRESENTATION'
        ? 'CREATOR'
        : template?.key === 'CREATOR_ACTIVATION'
          ? 'BRAND_CLIENT'
          : template?.subtype.includes('PUBLISHER')
            ? 'PUBLISHER'
            : 'MEDIA_BUYER',
    ],
    answers: {},
    sourceNotes: '',
    decisionMakerPartyId: null,
    unresolvedIssues: '',
    nextActionOwnerUserId: null,
    nextStep: '',
    dueDate: '',
    checkpoint: '',
  };
  return (
    <LoopPage label="New intake">
      <PageHead
        trail={[
          { label: 'CRM' },
          { label: 'Intake & Qualification', href: '/app/crm/intakes' },
          { label: 'New intake' },
        ]}
        title="Start with the work ahead."
        subtitle="Choose the engagement, then connect it to the CRM record you already know."
      />
      {!available || !options ? (
        <StateBlock
          kind="unavailable"
          title="Intake setup is not available yet."
          body="This deployment needs the intake database migration and the appropriate CRM permissions."
        />
      ) : !template ? (
        <div className="iq-templates">
          {['CREATOR_REPRESENTATION', 'CREATOR_ACTIVATION', 'PERFORMANCE_MEDIA'].map((key) => {
            const variants = INTAKE_TEMPLATES.filter((t) => t.key === key),
              first = variants[0]!;
            return (
              <section className="loop-panel iq-section" key={key}>
                <h2>{first.engagement}</h2>
                <p>{first.outputs.join(' · ')}</p>
                <div className="loop-btnrow">
                  {variants.map((t) => (
                    <Link
                      className="loop-btn"
                      key={t.subtype}
                      href={url(key, t.subtype, searchParams?.party)}
                    >
                      {t.label}
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <>
          <div className="iq-context">
            <strong>
              {template.engagement} · {template.label}
            </strong>
            <span>Template version {template.version}</span>
            <Link href={base}>Change engagement</Link>
          </div>
          {!party ? (
            <section className="loop-panel iq-section">
              <h2>Choose the CRM identity</h2>
              <form method="get" className="loop-filters">
                <input type="hidden" name="template" value={template.key} />
                <input type="hidden" name="subtype" value={template.subtype} />
                <label className="loop-field">
                  <span className="loop-label">Find a person or company</span>
                  <input
                    className="loop-input"
                    name="q"
                    maxLength={100}
                    defaultValue={searchParams?.q ?? ''}
                  />
                </label>
                <button className="loop-btn" type="submit">
                  Search CRM
                </button>
              </form>
              <form method="get" className="iq-section">
                <input type="hidden" name="template" value={template.key} />
                <input type="hidden" name="subtype" value={template.subtype} />
                <label className="loop-field">
                  <span className="loop-label">Existing identity</span>
                  <select className="loop-select" name="party" required>
                    <option value="">Select a record</option>
                    {options.parties
                      .filter(
                        (p) =>
                          template.key !== 'CREATOR_REPRESENTATION' || p.entityType === 'PERSON',
                      )
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.displayName ?? p.id} ·{' '}
                          {p.entityType === 'PERSON' ? 'Person' : 'Company'}
                        </option>
                      ))}
                  </select>
                </label>
                <button className="loop-btn loop-btn--primary" type="submit">
                  Use this CRM record
                </button>
              </form>
              {options.truncated ? (
                <p className="loop-note">
                  Showing the first 200 matches. Refine your search to find another record.
                </p>
              ) : null}
              <p className="loop-note">
                Choose an established identity.{' '}
                <Link href="/crm/parties">Open Identity Review</Link> if the record needs to be
                created or established.
              </p>
            </section>
          ) : (
            <>
              <div className="iq-context">
                <strong>{party.displayName ?? 'CRM identity'}</strong>
                <Link href={url(template.key, template.subtype)}>Change CRM record</Link>
              </div>
              <IntakeEditor
                template={template}
                parties={options.parties}
                owners={options.owners}
                partyId={party.id}
                requestKey={randomUUID()}
                content={content}
                opportunities={await repo.opportunities(
                  session.organizationId,
                  session.userId,
                  party.id,
                )}
              />
            </>
          )}
        </>
      )}
    </LoopPage>
  );
}
