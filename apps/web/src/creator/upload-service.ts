// Request-bound media operations. Permissions come from the session, never request fields.
import 'server-only';
import { creatorDomain } from './creator-runtime';
import { createMediaUploadService } from './media-upload.service';
export type { BeginUploadRequest, BeginUploadResult, CompleteUploadResult } from './media-upload.service';
export { parseProductionStep } from '@emgloop/database';

type UploadService = ReturnType<typeof createMediaUploadService>;
export const beginCreatorUpload = (...args: Parameters<UploadService['beginCreatorUpload']>) => createMediaUploadService(creatorDomain()).beginCreatorUpload(...args);
export const beginEmgUpload = (...args: Parameters<UploadService['beginEmgUpload']>) => createMediaUploadService(creatorDomain()).beginEmgUpload(...args);
export const completeUpload = (...args: Parameters<UploadService['completeUpload']>) => createMediaUploadService(creatorDomain()).completeUpload(...args);
export const resumeUpload = (...args: Parameters<UploadService['resumeUpload']>) => createMediaUploadService(creatorDomain()).resumeUpload(...args);
export const mayPlayVersion = (...args: Parameters<UploadService['mayPlayVersion']>) => createMediaUploadService(creatorDomain()).mayPlayVersion(...args);
