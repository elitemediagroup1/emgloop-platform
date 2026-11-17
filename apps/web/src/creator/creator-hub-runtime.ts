import 'server-only';
import { CreatorHubRepository, prisma } from '@emgloop/database';
export const creatorHubRepository = () => new CreatorHubRepository(prisma);
