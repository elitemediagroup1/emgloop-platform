'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireCreator, requireEmgActor, EMG_HREFS } from './creator-runtime';
import { creatorHubRepository } from './creator-hub-runtime';
import { loadCreatorBrandUpdates, groupCreatorBrandRows } from './creator-brand-updates';
import { viewerTime } from '../time/viewer-time';
export async function askCreatorTeamAction(data: FormData) {
  const seat = await requireCreator();
  const raw = String(data.get('brandId') ?? '');
  const brands = raw ? await loadCreatorBrandUpdates(seat, viewerTime()) : null;
  const brand = brands ? groupCreatorBrandRows(brands.rows).find((b) => b.brandId === raw) : null;
  if (raw && !brand) redirect('/app/creator/tasks?message=unavailable#team');
  let id: string | null = null;
  try {
    id = await creatorHubRepository().ask(seat.actor, {
      body: String(data.get('body') ?? ''),
      submission: String(data.get('submission') ?? ''),
      brandId: brand?.brandId ?? null,
      brand: brand?.brand ?? null,
    });
  } catch {}
  revalidatePath('/app/creator/tasks');
  revalidatePath('/app');
  redirect(`/app/creator/tasks?message=${id ? 'sent' : 'unavailable'}#team`);
}
export async function configureCreatorHubAction(data: FormData) {
  const seat = await requireEmgActor();
  const id = String(data.get('profileId') ?? '');
  const aliases: Record<string, string> = {};
  let valid = true;
  for (const line of String(data.get('aliases') ?? '')
    .split('\n')
    .filter((l) => l.trim())) {
    const parts = line.split('=');
    if (parts.length !== 2) {
      valid = false;
      break;
    }
    const [a, b] = parts.map((v) => v.trim());
    if (!a || !b) {
      valid = false;
      break;
    }
    aliases[a] = b;
  }
  const okay =
    valid &&
    (await creatorHubRepository().configure(
      seat.actor,
      id,
      data.getAll('team').map(String),
      aliases,
    ));
  revalidatePath('/app');
  revalidatePath('/app/creator/profile');
  revalidatePath('/app/creator/opportunities');
  redirect(`${EMG_HREFS.creator(id)}?hub=${okay ? 'saved' : 'unavailable'}#creator-support`);
}
export async function replyCreatorQuestionAction(data: FormData) {
  const seat = await requireEmgActor();
  const profile = String(data.get('profileId') ?? '');
  const okay = await creatorHubRepository().reply(
    seat.actor,
    profile,
    String(data.get('id') ?? ''),
    String(data.get('body') ?? ''),
    data.get('complete') === 'on',
  );
  revalidatePath('/app/creator/tasks');
  if (seat.workspace === 'EMPLOYEE') {
    revalidatePath(`/app/employee/work/${String(data.get('id') ?? '')}`);
    redirect(`/app/employee/work/${encodeURIComponent(String(data.get('id') ?? ''))}`);
  }
  redirect(`${EMG_HREFS.creator(profile)}?hub=${okay ? 'replied' : 'unavailable'}#creator-support`);
}

export async function markTeamReplyRead(data: FormData) {
  const seat = await requireCreator();
  await creatorHubRepository().markReplyRead(seat.actor, String(data.get('id') ?? ''));
  revalidatePath('/app/creator/tasks');
  revalidatePath('/app');
  redirect('/app/creator/tasks#team');
}
