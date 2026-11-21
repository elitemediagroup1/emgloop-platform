/** Versioned intake questions and validation. Identity and workflow activation remain separate acts. */
export const INTAKE_STATES = ['DRAFT', 'SUBMITTED', 'NEEDS_CLARIFICATION', 'QUALIFIED'] as const;
export type IntakeState = (typeof INTAKE_STATES)[number];
export const INTAKE_STATE_LABELS: Record<IntakeState, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted for review',
  NEEDS_CLARIFICATION: 'Needs clarification',
  QUALIFIED: 'Qualified',
};
export const INTAKE_RELATIONSHIP_ROLES = [
  'CREATOR',
  'BRAND_CLIENT',
  'MEDIA_BUYER',
  'PUBLISHER',
] as const;
export const INTAKE_ROLE_LABELS: Record<string, string> = {
  CREATOR: 'Creator',
  BRAND_CLIENT: 'Brand / client',
  MEDIA_BUYER: 'Media buyer',
  PUBLISHER: 'Publisher',
};
export interface IntakeField {
  id: string;
  label: string;
  section: string;
  required: boolean;
  help?: string;
}
export interface IntakeTemplate {
  key: string;
  engagement: string;
  subtype: string;
  label: string;
  version: number;
  fields: IntakeField[];
  outputs: string[];
}
const fields = (section: string, rows: [string, string, string?][]): IntakeField[] =>
  rows.map(([id, label, help]) => ({
    id,
    label,
    section,
    required: true,
    ...(help ? { help } : {}),
  }));
const representation: IntakeTemplate = {
  key: 'CREATOR_REPRESENTATION',
  engagement: 'Creator Representation',
  subtype: 'TALENT',
  label: 'Talent',
  version: 1,
  fields: [
    ...fields('Creator and audience', [
      ['social_handles', 'Social handles and profile links'],
      ['audience', 'Audience demographics and analytics sources'],
      ['engagement', 'Engagement and content performance'],
      ['categories', 'Content categories and strengths'],
    ]),
    ...fields('Commercial fit', [
      ['rates', 'Current rates and rate card'],
      ['partnerships', 'Past and current partnerships'],
      ['conflicts', 'Exclusivity and conflicts'],
      ['brand_preferences', 'Brand preferences and prohibited categories'],
      ['boundaries', 'Creative boundaries and approval preferences'],
    ]),
    ...fields('Representation and development', [
      ['agreement', 'Representation agreement and approval status'],
      ['commission', 'Commission and scope of representation'],
      [
        'payments',
        'Payment terms and setup status',
        'Use Creator Hub Payments for bank setup. Record terms and setup status here.',
      ],
      ['goals', 'Primary goals'],
      ['opportunities', 'Immediate partnership opportunities'],
    ]),
  ],
  outputs: ['Representation checklist', 'Rate card requirements', 'Talent development priorities'],
};
const activation: IntakeTemplate = {
  key: 'CREATOR_ACTIVATION',
  engagement: 'Creator Activation',
  subtype: 'CAMPAIGN',
  label: 'Campaign',
  version: 1,
  fields: [
    ...fields('Campaign goals', [
      ['objectives', 'Campaign objectives'],
      ['kpis', 'KPIs and success criteria'],
      ['audience', 'Target audience'],
      ['budget', 'Budget and allocation'],
    ]),
    ...fields('Creators and deliverables', [
      ['selection', 'Creator selection criteria and roster requirements'],
      ['deliverables', 'Deliverables and posting requirements'],
      ['usage', 'Usage rights and duration'],
      ['whitelisting', 'Whitelisting / partnership ad permissions'],
      ['exclusivity', 'Exclusivity'],
    ]),
    ...fields('Execution', [
      ['brief', 'Creative brief'],
      ['approvals', 'Approvals and decision responsibilities'],
      ['timeline', 'Timeline and milestones'],
      ['reporting', 'Reporting requirements'],
      ['payments', 'Payment schedule'],
      ['contracting', 'Contracting responsibilities'],
    ]),
  ],
  outputs: [
    'Campaign brief',
    'Creator shortlist requirements',
    'Budget allocation',
    'Activation milestones',
  ],
};
function performance(subtype: string, label: string, publisher: boolean): IntakeTemplate {
  return {
    key: 'PERFORMANCE_MEDIA',
    engagement: 'Performance Media',
    subtype,
    label,
    version: 1,
    fields: [
      ...fields('Coverage and economics', [
        ['vertical', 'Vertical and service types'],
        ['coverage', 'Geographic coverage'],
        [
          'pricing',
          publisher ? 'Publisher payouts and billing model' : 'CPA, CPL or qualified-call payouts',
        ],
        ['budget_caps', 'Budget, daily caps and pacing'],
        ['payment_terms', 'Payment terms'],
      ]),
      ...fields('Qualification and operations', [
        ['qualification', 'Qualified call / lead criteria'],
        ['returns', 'Rejection, return and dispute rules'],
        [
          'routing',
          publisher
            ? 'Delivery endpoint, routing and technical integration'
            : 'Routing, DIDs and delivery requirements',
        ],
        ['availability', 'Operating hours and time zone'],
        [
          'capacity',
          publisher ? 'Expected delivery volume and capacity' : 'Agent capacity and concurrency',
        ],
      ]),
      ...fields('Launch readiness', [
        [
          'sources',
          publisher
            ? 'Traffic sources, acquisition methods and source approvals'
            : 'Approved traffic sources and restrictions',
        ],
        ['attribution', 'Attribution and tracking'],
        ['compliance', 'Compliance and consent requirements'],
        ['dependencies', 'Technical and commercial launch dependencies'],
        ['pilot', 'Pilot criteria and activation plan'],
      ]),
    ],
    outputs: [
      publisher ? 'Publisher specification' : 'Buyer specification',
      'Pilot activation plan',
      'CallGrid setup requirements',
      'Compliance checklist',
    ],
  };
}
export const INTAKE_TEMPLATES: readonly IntakeTemplate[] = [
  representation,
  activation,
  performance('PAY_PER_CALL_BUYER', 'Pay-per-call buyer', false),
  performance('LEAD_GENERATION_BUYER', 'Lead-generation buyer', false),
  performance('LEAD_GENERATION_PUBLISHER', 'Lead-generation publisher', true),
  performance('PAY_PER_CALL_PUBLISHER', 'Pay-per-call publisher', true),
];
export function intakeTemplate(key: string, subtype: string) {
  return INTAKE_TEMPLATES.find((t) => t.key === key && t.subtype === subtype) ?? null;
}
export function readIntakeTemplate(value: unknown): IntakeTemplate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    !['key', 'engagement', 'subtype', 'label'].every((k) => typeof v[k] === 'string') ||
    !Number.isInteger(v.version) ||
    Number(v.version) < 1 ||
    !Array.isArray(v.fields) ||
    v.fields.length > 50 ||
    !Array.isArray(v.outputs) ||
    !v.outputs.every((o) => typeof o === 'string')
  )
    return null;
  if (
    !v.fields.every(
      (f) =>
        f &&
        typeof f === 'object' &&
        typeof f.id === 'string' &&
        /^[a-z_]+$/.test(f.id) &&
        typeof f.label === 'string' &&
        typeof f.section === 'string' &&
        typeof f.required === 'boolean' &&
        (f.help === undefined || typeof f.help === 'string'),
    )
  )
    return null;
  if (new Set(v.fields.map((f) => f.id)).size !== v.fields.length) return null;
  return v as unknown as IntakeTemplate;
}
export interface IntakeContent {
  opportunityId: string | null;
  title: string;
  relationshipRoles: string[];
  answers: Record<string, string>;
  sourceNotes: string;
  decisionMakerPartyId: string | null;
  unresolvedIssues: string;
  nextActionOwnerUserId: string | null;
  nextStep: string;
  dueDate: string;
  checkpoint: string;
}
export function intakeContent(raw: unknown): IntakeContent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (
    !['title', 'sourceNotes', 'unresolvedIssues', 'nextStep', 'dueDate', 'checkpoint'].every(
      (k) => typeof v[k] === 'string',
    )
  )
    return null;
  if (
    ![v.opportunityId, v.decisionMakerPartyId, v.nextActionOwnerUserId].every(
      (x) => x === null || typeof x === 'string',
    )
  )
    return null;
  if (
    !Array.isArray(v.relationshipRoles) ||
    !v.relationshipRoles.every((r) => typeof r === 'string') ||
    !v.answers ||
    typeof v.answers !== 'object' ||
    Array.isArray(v.answers) ||
    !Object.values(v.answers).every((a) => typeof a === 'string')
  )
    return null;
  return v as unknown as IntakeContent;
}
export function validateIntakeContent(
  template: IntakeTemplate,
  content: IntakeContent,
  state: IntakeState,
): string[] {
  const errors: string[] = [];
  if (!content.title.trim() || content.title.length > 160)
    errors.push('Enter a title of up to 160 characters.');
  if (
    !content.relationshipRoles.length ||
    new Set(content.relationshipRoles).size !== content.relationshipRoles.length ||
    content.relationshipRoles.some(
      (r) => !(INTAKE_RELATIONSHIP_ROLES as readonly string[]).includes(r),
    )
  )
    errors.push('Choose one or more relationship classifications.');
  const ids = new Set(template.fields.map((f) => f.id));
  if (
    Object.keys(content.answers).some((k) => !ids.has(k)) ||
    Object.values(content.answers).some((a) => a.length > 6000)
  )
    errors.push('Check the answers against this intake’s saved questions.');
  if (
    [content.unresolvedIssues, content.nextStep, content.checkpoint].some((v) => v.length > 3000) ||
    content.sourceNotes.length > 20000
  )
    errors.push('Shorten the notes or closing details.');
  if (
    content.dueDate &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(content.dueDate) ||
      !Number.isFinite(Date.parse(content.dueDate)) ||
      new Date(content.dueDate).toISOString().slice(0, 10) !== content.dueDate)
  )
    errors.push('Enter a valid due date.');
  if (state === 'SUBMITTED' || state === 'QUALIFIED') {
    for (const f of template.fields)
      if (f.required && !content.answers[f.id]?.trim())
        errors.push(`Complete ${f.label.toLowerCase()}.`);
    if (
      !content.decisionMakerPartyId ||
      !content.nextActionOwnerUserId ||
      !content.unresolvedIssues.trim() ||
      !content.nextStep.trim() ||
      !content.dueDate ||
      !content.checkpoint.trim()
    )
      errors.push(
        'Complete the decision-maker, unresolved issues, action owner, next step, due date and checkpoint.',
      );
  }
  return errors;
}
export const INTAKE_TRANSITIONS: Record<IntakeState, readonly IntakeState[]> = {
  DRAFT: ['DRAFT', 'SUBMITTED', 'NEEDS_CLARIFICATION'],
  SUBMITTED: ['SUBMITTED', 'NEEDS_CLARIFICATION', 'QUALIFIED'],
  NEEDS_CLARIFICATION: ['DRAFT', 'SUBMITTED', 'NEEDS_CLARIFICATION'],
  QUALIFIED: ['NEEDS_CLARIFICATION'],
};
