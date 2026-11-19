import type { CreatorContactDetailsInput } from '@emgloop/database';

const fields: {
  name: keyof CreatorContactDetailsInput;
  label: string;
  type?: string;
  autoComplete: string;
  limit: number;
  optional?: boolean;
}[] = [
  {
    name: 'personalEmail',
    label: 'Personal email address',
    type: 'email',
    autoComplete: 'email',
    limit: 254,
  },
  { name: 'phone', label: 'Phone number', type: 'tel', autoComplete: 'tel', limit: 40 },
  { name: 'dateOfBirth', label: 'Date of birth', type: 'date', autoComplete: 'bday', limit: 10 },
  {
    name: 'addressLine1',
    label: 'Street address or PO Box',
    autoComplete: 'shipping address-line1',
    limit: 200,
  },
  {
    name: 'addressLine2',
    label: 'Apartment, suite or unit (optional)',
    autoComplete: 'shipping address-line2',
    limit: 200,
    optional: true,
  },
  { name: 'city', label: 'City', autoComplete: 'shipping address-level2', limit: 100 },
  {
    name: 'region',
    label: 'State, province or region (if applicable)',
    autoComplete: 'shipping address-level1',
    limit: 100,
    optional: true,
  },
  {
    name: 'postalCode',
    label: 'ZIP or postal code',
    autoComplete: 'shipping postal-code',
    limit: 24,
  },
  { name: 'country', label: 'Country', autoComplete: 'shipping country-name', limit: 80 },
];

export function CreatorContactForm({
  details,
  action,
  today,
  managerProfileId,
}: {
  details: CreatorContactDetailsInput | null;
  action: (data: FormData) => void | Promise<void>;
  today: string;
  managerProfileId?: string;
}) {
  return (
    <form className="ch-contact-form" action={action}>
      {managerProfileId ? <input type="hidden" name="profileId" value={managerProfileId} /> : null}
      <p className="loop-note">
        {managerProfileId
          ? 'Update this creator’s personal contact information and preferred mailing address.'
          : 'Share your personal contact information with EMG. Your personal email can be different from your sign-in email.'}
      </p>
      <div className="ch-contact-grid">
        {fields.slice(0, 3).map((field) => (
          <ContactField key={field.name} field={field} details={details} today={today} />
        ))}
      </div>
      <h3>{managerProfileId ? 'Gift shipping address' : 'Where should gifted items go?'}</h3>
      <p className="loop-note">
        {managerProfileId
          ? 'Use the home or mailing address this creator prefers for gifted items and campaign packages.'
          : 'Use your home address or a mailing address you prefer for receiving gifted items and campaign packages.'}
      </p>
      <div className="ch-contact-grid">
        {fields.slice(3).map((field) => (
          <ContactField key={field.name} field={field} details={details} today={today} />
        ))}
      </div>
      <p className="loop-note">
        {managerProfileId
          ? 'These details are visible to this creator and authorized EMG managers.'
          : 'These details are visible to you and authorized EMG managers.'}
      </p>
      <button className="loop-btn loop-btn--primary" type="submit">
        Save contact details
      </button>
    </form>
  );
}

function ContactField({
  field,
  details,
  today,
}: {
  field: (typeof fields)[number];
  details: CreatorContactDetailsInput | null;
  today: string;
}) {
  return (
    <label className="loop-field">
      <span className="loop-label">{field.label}</span>
      <input
        className="loop-input"
        name={field.name}
        type={field.type ?? 'text'}
        autoComplete={field.autoComplete}
        maxLength={field.limit}
        required={!field.optional}
        max={field.type === 'date' ? today : undefined}
        defaultValue={details?.[field.name] ?? ''}
      />
    </label>
  );
}
