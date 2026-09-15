// Intake Record provenance -- where a legacy Customer row came from, read at read time.
//
// Intake slice, part 2 (docs/product/foundation-handoff.md §2.3; identity record §10).
// The 24,590 legacy Intake Records were overwhelmingly ingestion residue: records
// automatically created for callers and website visitors before identity Slice 1
// (#239) stopped ingestion from creating them. Product approved classifying them by
// the marks each creator left, **at read time only**: nothing is written back, and
// no record is hidden, deleted, merged or relinked because of its segment.
//
// ONE DEFINITION. The read-only People population audit (#240) and the CRM intake
// reads use this function, so a segment means the same thing in an operations
// report and on a screen.
//
// A SEGMENT IS PROVENANCE, NOT IDENTITY. It says how the row was created. It never
// says who the row is about, never makes a row a Person, and never ranks one row
// as more trustworthy than another.
//
// No vendor names in labels: the mark is the creating path, not the provider.
//
// PURE. No clock, no I/O.

export const INTAKE_PROVENANCE_SEGMENTS = [
  'INGESTION_CALL',
  'INGESTION_WEB_VISITOR',
  'INGESTION_WEB_LEAD',
  'INGESTION_OTHER_SOURCE',
  'SEED_OR_DEMO',
  'EXTERNAL_IMPORT',
  'UNMARKED',
] as const;
export type IntakeProvenanceSegment = (typeof INTAKE_PROVENANCE_SEGMENTS)[number];

/** Segments whose rows were created automatically by ingestion, which no longer creates them. */
export const INGESTION_PROVENANCE_SEGMENTS: readonly IntakeProvenanceSegment[] = [
  'INGESTION_CALL',
  'INGESTION_WEB_VISITOR',
  'INGESTION_WEB_LEAD',
  'INGESTION_OTHER_SOURCE',
];

export const INTAKE_PROVENANCE_LABELS: Record<IntakeProvenanceSegment, string> = {
  INGESTION_CALL: 'Created automatically from an inbound call',
  INGESTION_WEB_VISITOR: 'Created automatically from an anonymous website visit',
  INGESTION_WEB_LEAD: 'Created automatically from a website form',
  INGESTION_OTHER_SOURCE: 'Created automatically by an integration',
  SEED_OR_DEMO: 'Seed or demo data',
  EXTERNAL_IMPORT: 'Imported with an external id',
  UNMARKED: 'Origin not recorded',
};

export interface IntakeProvenanceInput {
  externalId: string | null;
  tags: readonly string[] | null;
  metadata: unknown;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Where an Intake Record came from, by the marks each creator left. Precedence is top-down. */
export function intakeProvenanceSegment(c: IntakeProvenanceInput): IntakeProvenanceSegment {
  const ext = (c.externalId ?? '').toLowerCase();
  const tags = (c.tags ?? []).map((t) => String(t).toLowerCase());
  if (ext.startsWith('web-visitor:') || tags.includes('anonymous-visitor')) return 'INGESTION_WEB_VISITOR';
  const createdFrom = text(obj(c.metadata).createdFrom);
  if (createdFrom === 'callgrid') return 'INGESTION_CALL';
  if (createdFrom === 'website') return 'INGESTION_WEB_LEAD';
  if (createdFrom) return 'INGESTION_OTHER_SOURCE';
  if (['sic-demo-', 'demo-', 'e2e-', 'test-', 'qa-', 'hotfix-verify'].some((p) => ext.startsWith(p))) return 'SEED_OR_DEMO';
  if (ext) return 'EXTERNAL_IMPORT';
  return 'UNMARKED';
}
