import { businessCallback } from '../../../../../tiktok-business/callback';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => businessCallback(request, 'CREATOR');
