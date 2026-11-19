'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { validateCreatorContactDetails, type CreatorContactDetailsInput } from '@emgloop/database';
import { requireCreator, EMG_HREFS } from './creator-runtime';
import { creatorHubRepository } from './creator-hub-runtime';

export async function saveCreatorContactDetails(data: FormData) {
  const seat = await requireCreator();
  const field = (key: string) => String(data.get(key) ?? '').trim();
  const input: CreatorContactDetailsInput = {
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
  if (validateCreatorContactDetails(input))
    redirect('/app/creator/profile?contact=invalid#contact-details');
  let saved = false;
  try {
    saved = await creatorHubRepository().saveContactDetails(seat.actor, input);
  } catch {
    // Contact values and provider errors must never be included in logs or URLs.
  }
  if (saved) {
    revalidatePath('/app/creator/profile');
    revalidatePath(EMG_HREFS.creator(seat.profileId));
  }
  redirect(`/app/creator/profile?contact=${saved ? 'saved' : 'unavailable'}#contact-details`);
}
