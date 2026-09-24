// Executive Brain — what it deliberately does not read, and what is not wired yet.
//
// The Executive Brain reads ORGANIZATION-SCOPED sources only, and it calls no model.
// These declarations are the two honest edges of that boundary, stated as data so a
// test can hold them to it:
//
//   EXCLUDED        sources that exist in Loop and that the Brain deliberately does not
//                   read -- an employee's own Gmail and Calendar (synced for that person
//                   only; never rolled up into an organization view), and the governed AI
//                   runtime's outputs. Each says what exists and why it is not read.
//   UNINSTRUMENTED  domains with no organization-level read feeding the Brain yet. Each
//                   says why and what would wire it.
//
// Nothing here may claim that the Brain reads a private source or calls a model; nothing
// here may claim a source does not exist when it does. Pure data.

import { excludedSensor, uninstrumentedSensor, type ExcludedSensor, type UninstrumentedSensor } from './sensor';

/**
 * Sources that exist in Loop and that the Executive Brain deliberately does not read.
 * Declared, never omitted, so the coverage board says what exists and why it is not
 * read -- and never implies the Brain sees an employee's private source or a model's
 * output.
 */
export const EXECUTIVE_EXCLUDED_SENSORS: readonly ExcludedSensor[] = [
  excludedSensor(
    'gmail',
    'Gmail',
    'Each employee can connect their own Gmail. Loop syncs that mailbox for that person only, in their own Mail.',
    'Mail is employee-private. The Executive Brain reads organization-scoped sources only and does not roll any employee’s mailbox into an organization view.',
  ),
  excludedSensor(
    'calendar',
    'Google Calendar',
    'Each employee can connect their own Google Calendar. Loop syncs it for that person only, in their own Calendar and Your day.',
    'Calendars are employee-private. The Executive Brain reads organization-scoped sources only and does not roll any employee’s calendar into an organization view.',
  ),
  excludedSensor(
    'ai-runtime',
    'AI runtime',
    'Loop has a governed AI runtime. Telegram content triage runs in the connections worker under each employee’s own consent; mail reply drafts and Case explanations are produced only when someone asks. Whether the web tier may call a model is set per environment.',
    'The Executive Brain does not take model output as evidence: triage results and mail drafts are employee-private, and a Case explanation belongs to its Case. The Executive Brain itself calls no model.',
  ),
];

/** The sensors that have no organization-level read feeding the Brain yet. Declared,
 * never omitted, so the coverage board states each gap and what would close it. */
export const EXECUTIVE_UNINSTRUMENTED_SENSORS: readonly UninstrumentedSensor[] = [
  uninstrumentedSensor(
    'tasks',
    'Tasks',
    'There is no Task model. The Work OS runtime is a separate domain (blueprint work), not a task list.',
    'A Task model with real task rows, or wiring the Work OS as its own sensor.',
  ),
  uninstrumentedSensor(
    'opportunities',
    'Opportunities',
    'CRM Opportunities are recorded, but no organization-level opportunity read feeds the Executive Brain yet.',
    'A windowed, organization-scoped opportunity sensor over the CRM Opportunity records.',
  ),
  uninstrumentedSensor(
    'creator-pipeline',
    'Creator Pipeline',
    'The Creator Hub records creators, their content and opportunities, but no organization-level creator read feeds the Executive Brain yet.',
    'A windowed, organization-scoped creator sensor over the Creator Hub’s records.',
  ),
  uninstrumentedSensor(
    'client-pipeline',
    'Client Pipeline',
    'The Client workspace is a shell stub with no persisted data.',
    'A client pipeline model with real client rows.',
  ),
];
