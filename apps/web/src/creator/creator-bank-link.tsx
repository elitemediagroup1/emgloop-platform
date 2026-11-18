'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { beginCreatorStripeBank, completeCreatorStripeBank } from './creator-payout-actions';
/** Only Stripe's hosted page handles identity/bank information. No bank token enters storage. */
export function CreatorBankLink() {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const router = useRouter();
  const confirmation = useRef<{ nonce: string; result: Promise<boolean> } | null>(null);
  useEffect(() => {
    const nonce = new URLSearchParams(window.location.search).get('bank_session');
    if (!nonce) return;
    let live = true;
    setBusy(true);
    if (confirmation.current?.nonce !== nonce)
      confirmation.current = { nonce, result: completeCreatorStripeBank(nonce) };
    confirmation.current.result
      .then((ok) => {
        if (!live) return;
        setMessage(
          ok
            ? 'Your bank account is ready.'
            : 'Bank setup is incomplete or expired. Start again to finish in Stripe.',
        );
        router.replace('/app/creator/earnings?payout=' + (ok ? 'bank-connected' : 'review'));
        router.refresh();
      })
      .catch(() => {
        if (live) setMessage('Bank setup could not be confirmed. No withdrawal was started.');
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [router]);
  return (
    <form
      className="ch-bank-form"
      action={async (form) => {
        setBusy(true);
        setMessage('');
        try {
          const result = await beginCreatorStripeBank(form);
          if ('url' in result) {
            window.location.assign(result.url);
            return;
          }
          setMessage(result.error);
        } catch {
          setMessage('Bank setup could not start. Try again shortly.');
        }
        setBusy(false);
      }}
    >
      <p>
        Secure bank setup is completed with Stripe. Loop stores only an encrypted recipient
        reference and masked account details.
      </p>
      <label>
        Legal name
        <input className="loop-input" name="legalName" required maxLength={150} />
      </label>
      <label>
        Who receives these earnings?
        <select className="loop-input" name="entityType">
          <option value="individual">Me as an individual</option>
          <option value="company">My registered business</option>
        </select>
      </label>
      <label>
        <input type="checkbox" name="consent" value="yes" required /> I authorize EMG to use this
        account for my approved creator payouts.
      </label>
      <button className="loop-btn" disabled={busy}>
        {busy ? 'Checking bank setup…' : 'Set up bank with Stripe →'}
      </button>
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}
