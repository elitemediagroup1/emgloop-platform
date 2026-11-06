// Who may invoke an AI task. Slice AI-1.
//
// An invocation spends the organization's money and sends its evidence to a third
// party, so the question is stricter than "may this person read the page":
//
//   1. an ACTIVE membership in the organization the session names;
//   2. a human -- never AI_EMPLOYEE. An AI invocation always traces to a person,
//      and an autonomous worker triggering model calls is a different product
//      decision that nobody has taken;
//   3. a membership role the task lists in `invokerRoles` (an empty list admits
//      nobody);
//   4. every permission in the task's `requires`, asked through `can()` -- the
//      enforcing path, where a Permission DENY wins -- and never through the
//      display-only `canEach`.
//
// Any error is a refusal. A check that could not be completed did not pass.

import type { PrismaClient } from '@prisma/client';
import { AI_TASK_CREATOR_ANALYTICS_READING, type AiTaskDefinition } from '@emgloop/shared';

import { IamRepository, type Action, type Resource } from '../../repositories/iam.repository';
import { CreatorRepository } from '../../creator/creator.repository';
import { membershipAuthority } from '../../repositories/membership.repository';
import type { AiAuthorizer, AiPrincipal } from './gateway';

/** Roles that may never invoke a model call, whatever a task definition says. */
export const AI_INVOKER_FORBIDDEN_ROLES: readonly string[] = Object.freeze(['AI_EMPLOYEE']);

export function iamAiAuthorizer(prisma: PrismaClient, iam: Pick<IamRepository, 'can'> = new IamRepository(prisma)): AiAuthorizer {
  return async (principal: AiPrincipal, task: AiTaskDefinition): Promise<boolean> => {
    try {
      if (!principal.organizationId?.trim() || !principal.userId?.trim()) return false;
      const authority = await membershipAuthority(prisma, principal.organizationId, principal.userId);
      if (!authority.granted) return false;
      const role = authority.systemRole;
      if (!role || AI_INVOKER_FORBIDDEN_ROLES.includes(role)) return false;
      if (!task.invokerRoles.includes(role)) return false;
      // This exact registered task spends only on the invoking creator's bound profile.
      // It grants no organization permission, and its producer rechecks the same profile on publication.
      if (task.taskId === AI_TASK_CREATOR_ANALYTICS_READING.taskId) {
        if (task !== AI_TASK_CREATOR_ANALYTICS_READING || role !== 'CREATOR') return false;
        return !!await new CreatorRepository(prisma).profileForUser(principal.organizationId, principal.userId);
      }
      if (task.requires.length === 0) return false;
      for (const requirement of task.requires) {
        const allowed = await iam.can({
          organizationId: principal.organizationId,
          userId: principal.userId,
          resource: requirement.resource as Resource,
          action: requirement.action as Action,
        });
        if (!allowed) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
}
