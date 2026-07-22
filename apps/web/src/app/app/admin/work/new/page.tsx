import Link from 'next/link';
import {
  RESPONSIBILITY_LABELS,
  PRIORITY_LABELS,
  WORK_PRIORITIES,
  WORK_RELATION_TYPES,
  RELATION_LABELS,
} from '@emgloop/database';
import { BUSINESS_TIME_ZONE_LABEL } from '@emgloop/shared';
import { requireWorkActor, workRepo } from '../work-data';
import StartWorkForm from './StartWorkForm';

// Start Work — create and assign work for anything the team needs to accomplish.
// This server component loads REAL work types (Blueprints) + active members and
// hands them to the client form leaf. No engine vocabulary reaches the screen.

export const dynamic = 'force-dynamic';

export default async function StartWorkPage() {
  const actor = await requireWorkActor();
  const [workTypes, members] = await Promise.all([
    workRepo().listWorkTypes(actor.organizationId),
    workRepo().listActiveMembers(actor.organizationId),
  ]);

  const responsibilities = Object.entries(RESPONSIBILITY_LABELS).map(([value, label]) => ({ value, label }));
  const priorities = WORK_PRIORITIES.map((value) => ({ value, label: PRIORITY_LABELS[value] }));
  const relations = WORK_RELATION_TYPES.map((value) => ({ value, label: RELATION_LABELS[value] }));

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
              responsibility: w.responsibility,
              defaultPriority: w.defaultPriority,
              hasDefaultAssignee: !!w.defaultAssigneeUserId,
            }))}
            members={members.map((m) => ({ id: m.id, name: m.name || m.email }))}
            responsibilities={responsibilities}
            priorities={priorities}
            relations={relations}
            timezoneLabel={BUSINESS_TIME_ZONE_LABEL}
          />
        )}
      </div>
    </div>
  );
}
