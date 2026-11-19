'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { validateCreatorContactDetails, type CreatorContactDetailsInput } from '@emgloop/database';
import { requireCreator, requireEmgActor, EMG_HREFS } from './creator-runtime';
import { creatorHubRepository } from './creator-hub-runtime';

export async function saveCreatorContactDetails(data: FormData) {
  const seat = await requireCreator();
  const input = contactInput(data);
  if (validateCreatorContactDetails(input))
    redirect('/app/creator/profile?contact=invalid#contact-details');
  let saved = false;
  try {
    saved = await creatorHubRepository().saveContactDetails(seat.actor, input);
  } catch {}
  if (saved) {
    revalidatePath('/app/creator/profile');
    revalidatePath(EMG_HREFS.creator(seat.profileId));
  }
  redirect(`/app/creator/profile?contact=${saved ? 'saved' : 'unavailable'}#contact-details`);
}

function contactInput(data: FormData): CreatorContactDetailsInput {
  const field = (key: string) => String(data.get(key) ?? '').trim();
  return {
    personalEmail: field('personalEmail'),
    phone: field('phone'),
    dateOfBirth: field('dateOfBirth'),
    addressLine1: field('addressLine1'),
    addressLine2: field('addressLine2'),
    city: field('city'),
    region: field('region'),
    postalCode: field('postalCode'),
    country: field('country'),
  };
}

export async function saveManagerCreatorContactDetails(data: FormData) {
  const seat = await requireEmgActor();
  const profileId = String(data.get('profileId') ?? '');
  const back = EMG_HREFS.creator(profileId);
  const input = contactInput(data);
  if (validateCreatorContactDetails(input)) redirect(`${back}?contact=invalid#contact-details`);
  let saved = false;
  try {
    saved = await creatorHubRepository().saveManagerContactDetails(seat.actor, profileId, input);
  } catch {}
  if (saved) {
    revalidatePath(back);
    revalidatePath('/app/creator/profile');
  }
  redirect(`${back}?contact=${saved ? 'saved' : 'unavailable'}#contact-details`);
}
