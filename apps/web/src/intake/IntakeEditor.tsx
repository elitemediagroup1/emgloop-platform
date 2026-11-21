'use client';
import { DecisionMakerSelect } from './DecisionMakerSelect';
import { useFormState, useFormStatus } from 'react-dom';
import {
  INTAKE_RELATIONSHIP_ROLES,
  INTAKE_ROLE_LABELS,
  INTAKE_STATE_LABELS,
  INTAKE_TRANSITIONS,
  type IntakeContent,
  type IntakeState,
  type IntakeTemplate,
} from '@emgloop/shared';
import { createQualificationIntake, reviseQualificationIntake } from './intake-actions';

export interface IntakeEditorProps {
  template: IntakeTemplate;
  identities: { id: string; displayName: string | null; entityType: string }[];
  owners: { id: string; name: string | null }[];
  content: IntakeContent;
  partyId: string;
  requestKey?: string;
  opportunities?: { id: string; title: string }[];
  record?: { id: string; revision: number; state: IntakeState };
  canApprove?: boolean;
}
export function IntakeEditor(props: IntakeEditorProps) {
  const { template, content, record } = props;
  const [result, action] = useFormState(
    record ? reviseQualificationIntake : createQualificationIntake,
    { errors: [] },
  );
  const sections = [...new Set(template.fields.map((f) => f.section))];
  return (
    <form className="iq-editor" action={action}>
      {result.errors.length ? (
        <div className="iq-errors" role="alert">
          <h2>Check these details</h2>
          <ul>
            {result.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <input type="hidden" name="partyId" value={props.partyId} />
      <input type="hidden" name="templateKey" value={template.key} />
      <input type="hidden" name="subtype" value={template.subtype} />
      <input type="hidden" name="requestKey" value={props.requestKey ?? ''} />
      {record ? (
        <>
          <input type="hidden" name="intakeId" value={record.id} />
          <input type="hidden" name="revision" value={record.revision} />
        </>
      ) : null}
      <section className="loop-panel iq-section">
        <h2>Engagement context</h2>
        <label className="loop-field">
          <span className="loop-label">Intake title</span>
          <input
            className="loop-input"
            name="title"
            defaultValue={content.title}
            maxLength={160}
            required
          />
        </label>
        <fieldset>
          <legend>Relationship classifications</legend>
          <p className="loop-note">Select every role that applies to this engagement.</p>
          <div className="iq-roles">
            {INTAKE_RELATIONSHIP_ROLES.map((role) => (
              <label key={role}>
                <input
                  type="checkbox"
                  name="relationshipRoles"
                  value={role}
                  defaultChecked={content.relationshipRoles.includes(role)}
                />{' '}
                {INTAKE_ROLE_LABELS[role]}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="loop-field">
          <span className="loop-label">Related opportunity (optional)</span>
          <select
            className="loop-select"
            name="opportunityId"
            defaultValue={content.opportunityId ?? ''}
          >
            <option value="">Choose later</option>
            {content.opportunityId &&
            !props.opportunities?.some((o) => o.id === content.opportunityId) ? (
              <option value={content.opportunityId}>Previously linked opportunity</option>
            ) : null}
            {props.opportunities?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </select>
          <span className="loop-note">
            Only opportunities already linked to this CRM identity appear here.
          </span>
        </label>
      </section>
      {sections.map((section) => (
        <section className="loop-panel iq-section" key={section}>
          <h2>{section}</h2>
          <div className="iq-fields">
            {template.fields
              .filter((f) => f.section === section)
              .map((field) => (
                <label className="loop-field" key={field.id}>
                  <span className="loop-label">{field.label}</span>
                  {field.help ? <span className="loop-note">{field.help}</span> : null}
                  <textarea
                    className="loop-textarea"
                    name={`answer_${field.id}`}
                    defaultValue={content.answers[field.id] ?? ''}
                    rows={3}
                    maxLength={6000}
                  />
                </label>
              ))}
          </div>
        </section>
      ))}
      <section className="loop-panel iq-section">
        <h2>Next step and accountability</h2>
        <p className="loop-note">
          Complete every closing detail before submitting or qualifying. Record “None” when there
          are no unresolved issues.
        </p>
        <div className="iq-fields">
          <DecisionMakerSelect
            people={props.identities.filter((p) => p.entityType === 'PERSON')}
            defaultValue={content.decisionMakerPartyId}
          />
          <label className="loop-field">
            <span className="loop-label">Next action owner</span>
            <select
              className="loop-select"
              name="nextActionOwnerUserId"
              defaultValue={content.nextActionOwnerUserId ?? ''}
            >
              <option value="">Assign an owner</option>
              {content.nextActionOwnerUserId &&
              !props.owners.some((o) => o.id === content.nextActionOwnerUserId) ? (
                <option value={content.nextActionOwnerUserId}>
                  Previous owner is unavailable. Choose another.
                </option>
              ) : null}
              {props.owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name ?? o.id}
                </option>
              ))}
            </select>
          </label>
          <label className="loop-field">
            <span className="loop-label">Unresolved issues</span>
            <textarea
              className="loop-textarea"
              name="unresolvedIssues"
              maxLength={3000}
              rows={3}
              defaultValue={content.unresolvedIssues}
            />
          </label>
          <label className="loop-field">
            <span className="loop-label">Agreed next step</span>
            <textarea
              className="loop-textarea"
              name="nextStep"
              maxLength={3000}
              rows={3}
              defaultValue={content.nextStep}
            />
          </label>
          <label className="loop-field">
            <span className="loop-label">Due date</span>
            <input
              className="loop-input"
              type="date"
              name="dueDate"
              defaultValue={content.dueDate}
            />
          </label>
          <label className="loop-field">
            <span className="loop-label">Next meeting or decision checkpoint</span>
            <textarea
              className="loop-textarea"
              name="checkpoint"
              maxLength={3000}
              rows={3}
              defaultValue={content.checkpoint}
            />
          </label>
        </div>
      </section>
      <section className="loop-panel iq-section">
        <h2>Conversation notes</h2>
        <p className="loop-note">Add supporting notes or a transcript excerpt for the reviewer.</p>
        <textarea
          className="loop-textarea"
          name="sourceNotes"
          defaultValue={content.sourceNotes}
          rows={5}
          maxLength={20000}
          aria-label="Conversation notes"
        />
      </section>
      <div className="iq-save">
        {record ? (
          <label className="loop-field">
            <span className="loop-label">Review state</span>
            <select
              className="loop-select"
              name="state"
              defaultValue={record.state === 'QUALIFIED' ? 'NEEDS_CLARIFICATION' : record.state}
            >
              {INTAKE_TRANSITIONS[record.state]
                .filter((s) => props.canApprove || s !== 'QUALIFIED')
                .map((state) => (
                  <option key={state} value={state}>
                    {INTAKE_STATE_LABELS[state]}
                  </option>
                ))}
            </select>
          </label>
        ) : (
          <p>Save a draft first, then submit it for review.</p>
        )}
        <SaveButton creating={!record} />
      </div>
    </form>
  );
}
function SaveButton({ creating }: { creating: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="loop-btn loop-btn--primary" type="submit" disabled={pending}>
      {pending ? 'Saving…' : creating ? 'Save intake draft' : 'Save revision'}
    </button>
  );
}
