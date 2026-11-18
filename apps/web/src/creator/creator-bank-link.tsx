'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  beginCreatorStripeBank,
  completeCreatorStripeBank,
  refreshCreatorStripeBank,
} from './creator-payout-actions';
/** Only Stripe's hosted page handles identity/bank information. No bank token enters storage. */
export function CreatorBankLink() {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const router = useRouter();
  const confirmation = useRef<{ nonce: string; result: Promise<boolean> } | null>(null);
  const refreshing = useRef<ReturnType<typeof refreshCreatorStripeBank> | null>(null);
  const [pendingNonce, setPendingNonce] = useState('');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const expired = params.get('bank_refresh');
    if (expired) {
      let live = true;
      setBusy(true);
      refreshing.current ??= refreshCreatorStripeBank(expired);
      refreshing.current
        .then((result) => {
          if (!live) return;
          if ('url' in result) window.location.assign(result.url);
          else {
            setMessage(result.error);
            setBusy(false);
          }
        })
        .catch(() => {
          if (live) {
            setMessage('Bank setup could not resume. Start again.');
            setBusy(false);
          }
        });
      return () => {
        live = false;
      };
    }
    const nonce = params.get('bank_session');
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
            : 'Stripe is still checking your setup, or the session expired. Check again shortly or restart setup.',
        );
        if (ok) {
          router.replace('/app/creator/earnings?payout=bank-connected');
          router.refresh();
        } else setPendingNonce(nonce);
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
      {pendingNonce ? (
        <button
          className="loop-btn"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const ok = await completeCreatorStripeBank(pendingNonce);
              if (ok) {
                router.replace('/app/creator/earnings?payout=bank-connected');
                router.refresh();
              } else
                setMessage(
                  'Stripe is still checking your setup, or the session expired. You can check again or restart setup.',
                );
            } catch {
              setMessage('Could not check bank setup. No withdrawal was started.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Check bank setup again
        </button>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}
