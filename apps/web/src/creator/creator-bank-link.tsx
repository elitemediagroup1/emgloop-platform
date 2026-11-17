'use client';
import Script from 'next/script';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { beginCreatorBank, finishCreatorBank } from './creator-payout-actions';
type LinkHandler = { open: () => void; destroy: () => void };
type LinkSession = { nonce: string; linkToken: string; at: number };
declare global {
  interface Window {
    Plaid?: {
      create: (options: {
        token: string;
        receivedRedirectUri?: string;
        onSuccess: (token: string, metadata: { accounts: { id: string }[] }) => void;
        onExit: () => void;
      }) => LinkHandler;
    };
  }
}
const STORAGE = 'emg-bank-link-session';
/** Link tokens are short-lived frontend credentials. Bank/access tokens never enter browser storage. */
export function CreatorBankLink() {
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const resumed = useRef(false),
    router = useRouter();
  function launch(session: LinkSession, redirect?: string) {
    if (!window.Plaid) throw Error('LINK_UNAVAILABLE');
    setBusy(true);
    sessionStorage.setItem(STORAGE, JSON.stringify(session));
    const handler = window.Plaid.create({
      token: session.linkToken,
      ...(redirect ? { receivedRedirectUri: redirect } : {}),
      onExit: () => {
        sessionStorage.removeItem(STORAGE);
        handler.destroy();
        setBusy(false);
      },
      onSuccess: async (token, metadata) => {
        try {
          if (metadata.accounts.length !== 1) throw Error('SELECT_ONE');
          const ok = await finishCreatorBank({
            nonce: session.nonce,
            publicToken: token,
            accountId: metadata.accounts[0]!.id,
          });
          setMessage(
            ok
              ? 'Your bank account is connected.'
              : 'The bank could not be saved. Please start again.',
          );
          if (ok) router.replace('/app/creator/earnings?payout=bank-connected');
          router.refresh();
        } catch {
          setMessage('The bank could not be saved. Please start again.');
        } finally {
          sessionStorage.removeItem(STORAGE);
          handler.destroy();
          setBusy(false);
        }
      },
    });
    handler.open();
  }
  useEffect(() => {
    if (
      !ready ||
      resumed.current ||
      !new URLSearchParams(window.location.search).has('oauth_state_id')
    )
      return;
    resumed.current = true;
    try {
      const raw = sessionStorage.getItem(STORAGE);
      if (!raw) throw Error();
      const session = JSON.parse(raw) as LinkSession;
      if (
        typeof session.nonce !== 'string' ||
        typeof session.linkToken !== 'string' ||
        Date.now() - session.at > 600000
      )
        throw Error();
      launch(session, window.location.href);
    } catch {
      sessionStorage.removeItem(STORAGE);
      setMessage('Your bank connection session expired. Please start again.');
    }
    // Resume once after Plaid loads. Session authority is rechecked on the server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  return (
    <>
      <Script
        src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"
        strategy="lazyOnload"
        onLoad={() => setReady(true)}
        onReady={() => setReady(true)}
        onError={() => setMessage('Bank connection could not load. Please try again later.')}
      />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage('');
          const form = new FormData(e.currentTarget);
          try {
            const result = await beginCreatorBank(form);
            if ('error' in result) {
              setMessage(result.error);
              setBusy(false);
              return;
            }
            launch({ ...result, at: Date.now() });
          } catch {
            setBusy(false);
            setMessage('Bank connection is unavailable. Please try again later.');
          }
        }}
      >
        <label htmlFor="bank-legal-name">Bank account holder’s legal name</label>
        <input id="bank-legal-name" name="legalName" required maxLength={150} autoComplete="name" />
        <label className="ch-consent">
          <input type="checkbox" name="consent" value="yes" required />I authorize EMG to send my
          approved earnings to this US bank account by ACH. I confirm that I own the account. This
          does not authorize debits from my account.
        </label>
        <button className="loop-btn loop-btn--primary" disabled={!ready || busy}>
          {busy ? 'Connecting…' : 'Connect bank securely'}
        </button>
      </form>
      {message ? <p role="status">{message}</p> : null}
    </>
  );
}
