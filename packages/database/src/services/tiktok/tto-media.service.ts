import { TtoReadError, type TtoPublicApi } from '@emgloop/providers';
import { TtoMediaRepository, type TtoViewer } from '../../repositories/tto-media.repository';
import { openBusinessGrant } from './tiktok-business.service';
export class TtoMediaService {
    constructor(private readonly repository: TtoMediaRepository, private readonly config: {
        key: Uint8Array;
        api: Pick<TtoPublicApi, 'accounts' | 'report'>;
    } | null) { }
    async choices(p: TtoViewer) {
        if (!this.config)
            return [];
        const grant = await this.repository.ownGrant(p);
        if (!grant?.tokenSealed)
            return [];
        const token = openBusinessGrant(p, 'TTO', null, grant.tokenSealed, this.config.key).accessToken;
        return this.config.api.accounts(token);
    }
    async select(p: TtoViewer, accountId: string) {
        if (!this.config)
            return false;
        const grant = await this.repository.ownGrant(p);
        if (!grant || !(await this.choices(p)).includes(accountId))
            return false;
        return (await this.repository.selectSource(p, grant.id, grant.revision, accountId)) !== null;
    }
    async refresh(p: TtoViewer, profileId: string, force = false) {
        if (!await this.repository.authorizedProfile(p, profileId))
            return 'NOT_PERMITTED';
        return this.sync(p.organizationId, profileId, force);
    }
    async sync(organizationId: string, profileId: string, force = false) {
        if (!this.config)
            return 'NOT_CONFIGURED';
        const claim = await this.repository.claim(organizationId, profileId, force, new Date());
        if (!claim)
            return 'NOT_DUE';
        try {
            const token = openBusinessGrant({ organizationId, userId: claim.source.userId }, 'TTO', null, claim.source.tokenSealed!, this.config.key).accessToken;
            const accounts = await this.config.api.accounts(token);
            if (!claim.source.ttoAccountId || !claim.source.importEnabled) {
                if (!claim.source.ttoAccountId && accounts.length !== 1)
                    throw new Error('SOURCE_SELECTION_REQUIRED');
                const revision = await this.repository.selectSource({ organizationId, userId: claim.source.userId }, claim.source.id, claim.source.revision, claim.source.ttoAccountId ?? accounts[0]!, claim.leaseId);
                if (revision === null)
                    throw new Error('WITHDRAWN');
                claim.source.revision = revision;
                claim.source.ttoAccountId = claim.source.ttoAccountId ?? accounts[0]!;
            }
            if (!accounts.includes(claim.source.ttoAccountId))
                throw new TtoReadError('PERMISSION_REQUIRED');
            const report = await this.config.api.report(token, claim.source.ttoAccountId, claim.handle, new Date());
            if (!await this.repository.publish(claim, report, new Date()))
                throw new Error('WITHDRAWN');
            return 'SYNCED';
        }
        catch (error) {
            const failure = error instanceof TtoReadError ? error.failure : error instanceof Error && ['TOKEN_UNOPENABLE', 'SOURCE_SELECTION_REQUIRED', 'WITHDRAWN'].includes(error.message) ? error.message : 'UNAVAILABLE';
            await this.repository.failure(claim, failure, new Date());
            return failure;
        }
    }
    async sweep() {
        const rows = await this.repository.targets();
        let examined = 0;
        for (const row of rows) {
            examined++;
            const result = await this.sync(row.organizationId, row.id);
            if (!['NOT_DUE', 'NOT_CONFIGURED'].includes(result))
                return { examined, result };
        }
        return { examined, result: 'NOT_DUE' };
    }
}
