import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { IamRepository } from '../src/repositories/iam.repository';
import { TtoMediaRepository } from '../src/repositories/tto-media.repository';
import { parseTtoReport } from '../../providers/src/tiktok-business/public-insights';
const url = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const local = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
test('Postgres: creator isolation, claim concurrency, revision and handle fences, backoff and offboarding', { skip: local ? false : 'Disposable localhost Postgres required' }, async () => {
    const db = new PrismaClient({ datasources: { db: { url } } });
    const org = `media_${randomUUID()}`, other = `media_${randomUUID()}`;
    try {
        await db.organization.createMany({ data: [{ id: org, name: 'A', slug: org }, { id: other, name: 'B', slug: other }] });
        const iam = new IamRepository(db), repo = new TtoMediaRepository(db);
        const admin = await iam.createUser({ organizationId: org, email: 'admin@example.test', systemRole: 'OWNER' });
        await iam.activateUser(org, admin.id);
        const user = await iam.createUser({ organizationId: org, email: 'creator@example.test', systemRole: 'CREATOR' });
        await iam.activateUser(org, user.id);
        const profile = await db.creatorProfile.create({ data: { organizationId: org, userId: user.id, partyId: 'test-media-party', displayName: 'Creator', preferences: { socialHandles: { TIKTOK: 'trevonbassmaster' } } } });
        const p = { organizationId: org, userId: user.id };
        const grant = await db.tikTokBusinessConnection.create({ data: { organizationId: org, userId: admin.id, kind: 'TTO', status: 'CONNECTED', tokenSealed: Buffer.from('test-ciphertext'), ttoAccountId: '12345', importEnabled: true } });
        assert.equal((await repo.ownGrant({organizationId:org,userId:admin.id,sessionId:'extra-session-context'} as typeof p))?.id,grant.id);
        assert.equal(await repo.authorizedProfile({ ...p, organizationId: other }, profile.id), null);
        const now = new Date();
        const attempts = await Promise.allSettled(Array.from({ length: 3 }, () => repo.claim(org, profile.id, true, now)));
        const claims = attempts.flatMap(a => a.status === 'fulfilled' && a.value ? [a.value] : []);
        assert.equal(claims.length, 1);
        const claim = claims[0]!;
        const report = parseTtoReport('trevonbassmaster', { handle_name: 'trevonbassmaster', creator_id: '12345', followers_count: 0 }, { posts: [] }, now);
        assert.equal(await repo.publish(claim, report, now), true);
        assert.equal((await repo.read(p, profile.id, now))?.report?.followers, 0);
        const duplicate=await db.creatorProfile.create({data:{organizationId:org,partyId:'duplicate-test-party',displayName:'Duplicate handle',preferences:{socialHandles:{TIKTOK:'trevonbassmaster'}}}});
        assert.equal(await repo.read(p,profile.id,now),null);
        await db.creatorProfile.delete({where:{id:duplicate.id}});
        await db.permission.create({data:{organizationId:org,userId:admin.id,resource:'integrations',action:'update',effect:'DENY'}});
        assert.equal(await repo.read(p,profile.id,now),null);
        await db.permission.deleteMany({where:{organizationId:org,userId:admin.id}});

        assert.equal(await repo.read({ ...p, userId: 'someone-else' }, profile.id, now), null);
        assert.equal(await repo.claim(org, profile.id, true, new Date(+now + 60000)), null);
        await db.creatorProfile.update({ where: { id: profile.id }, data: { preferences: { socialHandles: { TIKTOK: 'differentcreator' } } } });
        assert.equal(await repo.read(p, profile.id, now), null);
        const changed = await repo.claim(org, profile.id, true, new Date(+now + 121000));
        assert.ok(changed);
        assert.equal((await db.ttoCreatorSnapshot.findFirst({ where: { organizationId: org } }))?.lastReadAt, null);
        assert.equal(await repo.publish(changed, report, new Date(+now + 122000)), false);
        await repo.failure(changed, 'RATE_LIMITED', new Date(+now + 122000));
        assert.equal(await repo.claim(org, profile.id, true, new Date(+now + 300000)), null);
        const next = await repo.claim(org, profile.id, true, new Date(+now + 4000000));
        assert.ok(next);
        await db.tikTokBusinessConnection.update({ where: { id: grant.id }, data: { revision: { increment: 1 } } });
        const updatedReport = { ...report, handle: 'differentcreator' };
        assert.equal(await repo.publish(next, updatedReport, new Date(+now + 4001000)), false);
        await iam.disableUser(org, admin.id);
        assert.equal(await repo.read(p, profile.id, new Date()), null);
        assert.equal(await db.ttoCreatorSnapshot.count({ where: { organizationId: org } }), 0);
    }
    finally {
        await db.organization.deleteMany({ where: { id: { in: [org, other] } } });
        await db.$disconnect();
    }
});
