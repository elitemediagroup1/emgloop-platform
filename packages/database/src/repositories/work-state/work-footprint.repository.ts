// How much work state one person holds: row COUNTS, per table. READ-ONLY.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §20 (the employee-private
// scope). It exists so an operator can prove that a source was actually read into a person's own
// work state -- "Loop holds 212 of this person's messages" -- without anyone reading a subject, an
// address or a title. It returns numbers and nothing else.
//
// SCOPED LIKE EVERY OTHER READ HERE. `workScope` requires both the organization and the person,
// so there is no call that counts a colleague's rows, or an organization's in aggregate.
import type { PrismaClient } from '@prisma/client';
import { workScope, type WorkPrincipal } from './work-principal';

export interface WorkFootprint {
  readonly threads: number;
  readonly messages: number;
  readonly correspondents: number;
  readonly items: number;
  readonly events: number;
  readonly documents: number;
}

export class WorkFootprintRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async counts(principal: WorkPrincipal): Promise<WorkFootprint> {
    const where = workScope(principal);
    const [threads, messages, correspondents, items, events, documents] = await Promise.all([
      this.prisma.workThread.count({ where }),
      this.prisma.workMessage.count({ where }),
      this.prisma.workCorrespondent.count({ where }),
      this.prisma.workItem.count({ where }),
      this.prisma.workEvent.count({ where }),
      this.prisma.workDocument.count({ where }),
    ]);
    return Object.freeze({ threads, messages, correspondents, items, events, documents });
  }
}
