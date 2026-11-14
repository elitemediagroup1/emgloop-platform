import { prisma, TtoMediaRepository, TtoMediaService } from '@emgloop/database';
import { readBusinessConfig, TtoPublicApi } from '@emgloop/providers';
import { appOrigin } from '@emgloop/shared';
// Scheduled functions cannot be invoked through a public HTTP URL. Only the published deploy runs.
export default async () => {
    const config = readBusinessConfig('TTO', process.env, appOrigin());
    if (!config)
        return;
    const service = new TtoMediaService(new TtoMediaRepository(prisma), { key: config.key, api: new TtoPublicApi(config) });
    try {
        const result = await service.sweep();
        console.info('tto-creator-sync', result);
    }
    catch {
        console.error('tto-creator-sync unavailable');
        throw new Error('TTO_SYNC_UNAVAILABLE');
    }
};
// One due creator per invocation; public snapshots become due after six hours.
export const config = { schedule: '*/10 * * * *' };
