'use client';

// The Telegram sign-in widget: the ONLY interactive leaf in Connections. It walks the person through
// phone -> code -> (2FA) inside Loop's secure flow and, on success, refreshes so the tile reads Ready.
//
// It is NOT a chat surface -- it establishes an authorized session so Loop can observe. The phone,
// code and 2FA password are typed here and sent straight to the server action (which forwards them to
// the worker over the signed channel); nothing is kept beyond the input, and the fields are cleared
// after each step. There is no composer, message list or reply anywhere in this component.

import { useState, useTransition } from 'react';

import {
  cancelTelegramLoginAction,
  startTelegramLoginAction,
  submitTelegramCodeAction,
  submitTelegramPasswordAction,
  type TelegramLoginResult,
} from '../../../connections/telegram-connect-actions';

type Step = 'idle' | 'phone' | 'code' | 'password' | 'done' | 'unavailable';

export function TelegramConnectFlow({ label }: { label: string }) {
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [pending, startTransition] = useTransition();

  function apply(result: TelegramLoginResult) {
    setValue('');
    setError(null);
    switch (result.step) {
      case 'CODE_SENT':
        setStep('code');
        break;
      case 'PASSWORD_NEEDED':
        setStep('password');
        break;
      case 'AUTHORIZED':
        setStep('done');
        // Reload so the server re-reads the connection and the tile shows its true (Ready) state.
        if (typeof window !== 'undefined') window.location.reload();
        break;
      case 'NO_LOGIN_IN_PROGRESS':
        setStep('phone');
        setError('That sign-in expired. Start again.');
        break;
      case 'NOT_AVAILABLE':
        setStep('unavailable');
        setError(result.reason ?? null);
        break;
      default:
        setError(result.reason ?? 'That did not work. Try again.');
    }
  }

  function run(fn: () => Promise<TelegramLoginResult>) {
    startTransition(async () => {
      apply(await fn());
    });
  }

  function reset() {
    startTransition(async () => {
      await cancelTelegramLoginAction();
      setStep('idle');
      setValue('');
      setError(null);
    });
  }

  if (step === 'idle') {
    return (
      <button className="loop-btn loop-btn--primary" type="button" disabled={pending} onClick={() => { setError(null); setStep('phone'); }}>
        Connect {label}
      </button>
    );
  }

  if (step === 'done') {
    return <p className="loop-panel__lead" role="status">Signed in. Finishing up…</p>;
  }

  if (step === 'unavailable') {
    return (
      <div className="loop-stack" role="status">
        <p className="loop-panel__lead">{error ?? `${label} is not available right now.`}</p>
        <button className="loop-btn" type="button" onClick={() => { setStep('idle'); setError(null); }}>Back</button>
      </div>
    );
  }

  const config = {
    phone: { label: 'Your Telegram phone number', type: 'tel', placeholder: '+1 555 123 4567', autoComplete: 'tel', button: 'Send code', run: () => run(() => startTelegramLoginAction(value)) },
    code: { label: 'Enter the code Telegram sent you', type: 'text', placeholder: '12345', autoComplete: 'one-time-code', button: 'Verify code', run: () => run(() => submitTelegramCodeAction(value)) },
    password: { label: 'Your two-step verification password', type: 'password', placeholder: '••••••••', autoComplete: 'current-password', button: 'Confirm', run: () => run(() => submitTelegramPasswordAction(value)) },
  }[step];

  return (
    <form
      className="loop-stack"
      onSubmit={(e) => { e.preventDefault(); if (value.trim() !== '') config.run(); }}
    >
      <label className="loop-panel__lead" htmlFor="tg-input">{config.label}</label>
      <input
        id="tg-input"
        className={"sw2-input" + (error ? " sw2-input--err" : "")}
        type={config.type}
        inputMode={step === 'phone' ? 'tel' : step === 'code' ? 'numeric' : 'text'}
        placeholder={config.placeholder}
        autoComplete={config.autoComplete}
        value={value}
        disabled={pending}
        onChange={(e) => setValue(e.target.value)}
        aria-describedby={error ? 'tg-error' : undefined}
      />
      {error ? <p id="tg-error" className="loop-state__body" role="alert">{error}</p> : null}
      <p className="muted">Loop uses this only to sign you in to Telegram. It is never stored, and Loop never posts on your behalf.</p>
      <div className="loop-btnrow">
        <button className="loop-btn loop-btn--primary" type="submit" disabled={pending || value.trim() === ''}>
          {pending ? 'Working…' : config.button}
        </button>
        <button className="loop-btn" type="button" disabled={pending} onClick={reset}>Cancel</button>
      </div>
    </form>
  );
}
