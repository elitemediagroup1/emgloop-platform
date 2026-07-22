import Link from 'next/link';
import { RESPONSIBILITY_LABELS, PRIORITY_LABELS, WORK_PRIORITIES } from '@emgloop/database';
import { BUSINESS_TIME_ZONE_LABEL } from '@emgloop/shared';
import { requireWorkActor, workRepo } from '../work-data';
import StartWorkForm from './StartWorkForm';

// Start Work — create and assign work for anything the team needs to accomplish.
// This server component loads REAL work types (with their configured custom
// fields), active de-duplicated members, and the org's active workflow templates,
// then hands them to the client builder leaf. No engine vocabulary reaches the
// screen; the client owns only interaction (section state, the step builder, the
// live review, field errors, submit-once).

export const dynamic = 'force-dynamic';

export default async function StartWorkPage() {
  const actor = await requireWorkActor();
  const [workTypes, members, templates] = await Promise.all([
    workRepo().listWorkTypes(actor.organizationId),
    workRepo().listActiveMembers(actor.organizationId),
    workRepo().listWorkflowTemplates(actor.organizationId),
  ]);

  const responsibilities = Object.entries(RESPONSIBILITY_LABELS).map(([value, label]) => ({ value, label }));
  const priorities = WORK_PRIORITIES.map((value) => ({ value, label: PRIORITY_LABELS[value] }));

  return (
    <div className="loop-os">
      <div className="sw2">
        <div className="sw2-head">
          <h1 className="sw2-title">Start Work</h1>
          <p className="sw2-sub">Create and assign work for anything the team needs to accomplish.</p>
        </div>

        {workTypes.length === 0 ? (
          <div className="sw2-empty">
            <p>No work types exist yet. An administrator sets these up once, then anyone can start work from them.</p>
            <Link href="/app/admin/administration/work-types" className="adm-btn adm-btn--primary">Set up work types</Link>
          </div>
        ) : (
          <StartWorkForm
            workTypes={workTypes.map((w) => ({
              id: w.id,
              name: w.name,
              category: w.category,
              fields: w.fields,
            }))}
            members={members.map((m) => ({ id: m.id, name: m.name || m.email }))}
            responsibilities={responsibilities}
            priorities={priorities}
            templates={templates.map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
              workTypeIds: t.workTypeIds,
              stepCount: t.stepCount,
              updatedAt: t.updatedAt,
              steps: t.steps.map((s) => ({
                name: s.name,
                instruction: s.instruction,
                mode: s.assignment.mode,
                specificUserId: s.assignment.specificUserId ?? null,
                responsibilityKey: s.assignment.responsibilityKey ?? null,
                completionConfirmation: s.completionConfirmation,
                completionNote: s.completionNote,
                notifyActive: s.notifyActive,
                notifyComplete: s.notifyComplete,
              })),
            }))}
            timezoneLabel={BUSINESS_TIME_ZONE_LABEL}
          />
        )}
      </div>
    </div>
  );
}
