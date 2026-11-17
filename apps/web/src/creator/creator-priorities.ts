import type { CreatorTask, PublishedCreatorBrandUpdate } from '@emgloop/database';
export interface CreatorBrandPriority {
  id: string;
  brand: string;
  update: PublishedCreatorBrandUpdate;
}
export function actionableBrand(update: PublishedCreatorBrandUpdate | undefined, now: Date) {
  return (
    !!update &&
    update.stage === 'AWAITING_CREATOR' &&
    update.current &&
    !!update.evidenceAt &&
    +update.evidenceAt <= +now &&
    +now - +update.evidenceAt <= 30 * 86400000
  );
}
export function creatorPriorities(
  tasks: readonly CreatorTask[],
  brands: readonly CreatorBrandPriority[],
  now: Date,
): CreatorTask[] {
  const result = [...tasks];
  for (const b of brands)
    if (actionableBrand(b.update, now))
      result.push({
        key: `brand:${b.id}`,
        kind: 'PARTNERSHIP',
        title: `Respond about ${b.brand}`,
        detail: b.update.nextStep || 'Review the latest partnership update with EMG.',
        dueAt: null,
        href: `/app/creator/opportunities?stage=1&brand=${encodeURIComponent(b.id)}#creator-response`,
        bucket: 'NEEDS_ATTENTION',
      });
  return result.sort(
    (a, b) =>
      (a.bucket === 'NEEDS_ATTENTION' ? 0 : 1) - (b.bucket === 'NEEDS_ATTENTION' ? 0 : 1) ||
      (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity) ||
      a.title.localeCompare(b.title),
  );
}
