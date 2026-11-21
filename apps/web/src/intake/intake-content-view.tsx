import { INTAKE_ROLE_LABELS, type IntakeContent, type IntakeTemplate } from '@emgloop/shared';
export function IntakeContentView({
  template,
  content,
  names = [],
  owners = [],
}: {
  template: IntakeTemplate;
  content: IntakeContent;
  names?: { id: string; displayName: string | null }[];
  owners?: { id: string; name: string | null }[];
}) {
  return (
    <div className="iq-reading">
      <p>{content.relationshipRoles.map((r) => INTAKE_ROLE_LABELS[r] ?? r).join(' · ')}</p>
      <dl>
        {template.fields.map((field) => (
          <div key={field.id}>
            <dt>{field.label}</dt>
            <dd>{content.answers[field.id] || 'Not recorded'}</dd>
          </div>
        ))}
        <div>
          <dt>Decision-maker</dt>
          <dd>
            {names.find((n) => n.id === content.decisionMakerPartyId)?.displayName ??
              (content.decisionMakerPartyId ? 'Previously linked person' : 'Not recorded')}
          </dd>
        </div>
        <div>
          <dt>Next action owner</dt>
          <dd>
            {owners.find((n) => n.id === content.nextActionOwnerUserId)?.name ??
              (content.nextActionOwnerUserId ? 'Previously assigned staff member' : 'Not recorded')}
          </dd>
        </div>
        <div>
          <dt>Unresolved issues</dt>
          <dd>{content.unresolvedIssues || 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Agreed next step</dt>
          <dd>{content.nextStep || 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Due date</dt>
          <dd>{content.dueDate || 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Next meeting or decision checkpoint</dt>
          <dd>{content.checkpoint || 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Opportunity reference</dt>
          <dd>{content.opportunityId || 'Not linked'}</dd>
        </div>
        <div>
          <dt>Conversation notes</dt>
          <dd>{content.sourceNotes || 'Not recorded'}</dd>
        </div>
      </dl>
    </div>
  );
}
