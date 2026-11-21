import 'server-only';
import { prisma, QualificationIntakeRepository } from '@emgloop/database';
export const qualificationIntakes = () => new QualificationIntakeRepository(prisma);
