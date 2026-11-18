'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireCreator, requireEmgActor } from './creator-runtime';
import { creatorPayouts, creatorPayoutLedger } from './creator-payout-runtime';
const refresh = () => {
  revalidatePath('/app/creator/earnings');
  revalidatePath('/app');
};
type BankLinkStart = { nonce: string; linkToken: string } | { error: string };
export async function beginCreatorBank(form: FormData): Promise<BankLinkStart> {
  const seat = await requireCreator(),
    service = creatorPayouts();
  if (!service) return { error: 'Bank linking is not enabled. Ask EMG about payment setup.' };
  try {
    return await service.beginLink(
      seat.actor,
      String(form.get('legalName') ?? ''),
      form.get('consent') === 'yes',
    );
  } catch {
    return {
      error: 'Bank linking could not start. Check that no payout is pending, then try again.',
    };
  }
}
export async function finishCreatorBank(input: {
  nonce: string;
  publicToken: string;
  accountId: string;
}) {
  const seat = await requireCreator(),
    service = creatorPayouts();
  if (!service) return false;
  try {
    const ok = await service.finishLink(
      seat.actor,
      input.nonce,
      input.publicToken,
      input.accountId,
    );
    refresh();
    return ok;
  } catch {
    return false;
  }
}
export async function disconnectCreatorBank() {
  const seat = await requireCreator(),
    service = creatorPayouts();
  let ok = false;
  try {
    ok = (await service?.disconnect(seat.actor)) ?? false;
  } catch {}
  refresh();
  redirect(`/app/creator/earnings?payout=${ok ? 'disconnected' : 'review'}`);
}
export async function requestCreatorPayout(form: FormData) {
  const seat = await requireCreator(),
    service = creatorPayouts();
  let ok = false;
  try {
    const id = await service?.request(
      seat.actor,
      String(form.get('payoutId') ?? ''),
      form.get('confirm') === 'yes',
    );
    if (id) {
      ok = true;
      await service!.process(id);
    }
  } catch {}
  refresh();
  redirect(`/app/creator/earnings?payout=${ok ? 'requested' : 'review'}`);
}
export async function approveCreatorPayout(form: FormData) {
  const seat = await requireEmgActor(),
    service = creatorPayoutLedger(seat.actor.organizationId),
    profileId = String(form.get('profileId') ?? '');
  const amount = String(form.get('amount') ?? '');
  let ok = false;
  try {
    if (/^\d{1,7}(\.\d{1,2})?$/.test(amount) && form.get('confirm') === 'yes') {
      const [whole, decimal = ''] = amount.split('.');
      const minor = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
      ok =
        (await service?.approve(seat.actor, {
          profileId,
          amountMinor: minor,
          description: String(form.get('description') ?? ''),
          earningReference: String(form.get('earningReference') ?? ''),
          submission: String(form.get('submission') ?? ''),
        })) ?? false;
    }
  } catch {}
  refresh();
  revalidatePath(`/app/admin/creator-hub/${profileId}`);
  redirect(
    `/app/admin/creator-hub/${encodeURIComponent(profileId)}?payout=${ok ? 'approved' : 'unavailable'}#creator-payments`,
  );
}

export async function cancelCreatorPayout(form: FormData) {
  const seat = await requireEmgActor(),
    service = creatorPayoutLedger(seat.actor.organizationId),
    profileId = String(form.get('profileId') ?? '');
  let ok = false;
  try {
    ok =
      (await service?.cancel(seat.actor, profileId, String(form.get('payoutId') ?? ''))) ?? false;
  } catch {}
  refresh();
  revalidatePath(`/app/admin/creator-hub/${profileId}`);
  redirect(
    `/app/admin/creator-hub/${encodeURIComponent(profileId)}?payout=${ok ? 'cancelled' : 'unavailable'}#creator-payments`,
  );
}

export async function fundCreatorPayout(form: FormData) {
  const seat = await requireEmgActor(),
    service = creatorPayouts(),
    profileId = String(form.get('profileId') ?? '');
  let ok = false;
  try {
    ok =
      (await service?.fund(
        seat.actor,
        profileId,
        String(form.get('payoutId') ?? ''),
        form.get('confirm') === 'yes',
      )) ?? false;
  } catch {}
  refresh();
  revalidatePath(`/app/admin/creator-hub/${profileId}`);
  redirect(
    `/app/admin/creator-hub/${encodeURIComponent(profileId)}?payout=${ok ? 'funding' : 'unavailable'}#creator-payments`,
  );
}
export async function releaseCreatorPayout(form: FormData) {
  const seat = await requireEmgActor(),
    service = creatorPayouts(),
    profileId = String(form.get('profileId') ?? '');
  let ok = false;
  try {
    ok =
      (await service?.release(
        seat.actor,
        profileId,
        String(form.get('payoutId') ?? ''),
        form.get('confirm') === 'yes',
      )) ?? false;
  } catch {}
  refresh();
  revalidatePath(`/app/admin/creator-hub/${profileId}`);
  redirect(
    `/app/admin/creator-hub/${encodeURIComponent(profileId)}?payout=${ok ? 'released' : 'unavailable'}#creator-payments`,
  );
}

type StripeBankLinkStart = { url: string } | { error: string };
export async function beginCreatorStripeBank(form: FormData): Promise<StripeBankLinkStart> {
  const seat = await requireCreator(),
    service = creatorPayouts();
  if (!service) return { error: 'Bank payouts are awaiting EMG’s Stripe setup.' };
  const entityType = form.get('entityType');
  if (entityType !== 'individual' && entityType !== 'company')
    return { error: 'Choose the recipient type.' };
  try {
    return await service.beginHostedLink(
      seat.actor,
      String(form.get('legalName') ?? ''),
      form.get('consent') === 'yes',
      entityType,
    );
  } catch {
    return {
      error: 'Bank setup could not start. Check that no payout is pending, then try again.',
    };
  }
}
export async function completeCreatorStripeBank(nonce: string): Promise<boolean> {
  const seat = await requireCreator(),
    service = creatorPayouts();
  if (!service) return false;
  try {
    const ok = await service.finishHostedLink(seat.actor, nonce);
    refresh();
    return ok;
  } catch {
    return false;
  }
}

export async function refreshCreatorStripeBank(nonce: string): Promise<StripeBankLinkStart> {
  const seat = await requireCreator(),
    service = creatorPayouts();
  if (!service) return { error: 'Bank payouts are awaiting EMG’s Stripe setup.' };
  try {
    return await service.refreshHostedLink(seat.actor, nonce);
  } catch {
    return { error: 'This setup link expired. Start bank setup again.' };
  }
}
