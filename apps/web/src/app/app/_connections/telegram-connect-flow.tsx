'use client';

// The Telegram sign-in widget: the ONLY interactive leaf in Connections. It walks the person through
// phone -> code -> (2FA) inside Loop's secure flow and, on success, offers a bounded HISTORICAL
// BASELINE depth chooser before returning to the tile.
//
// It is NOT a chat surface -- it establishes an authorized session so Loop can observe. The phone,
// code and 2FA password are typed here and sent straight to the server action (which forwards them to
// the worker over the signed channel); nothing is kept beyond the input, and the fields are cleared
// after each step. There is no composer, message list, reply, or any message CONTENT anywhere here.
//
// The baseline chooser offers only a CLOSED set of windows (30/90/180/365 days, default 90) and a
// "Don't import history" option -- there is deliberately no all-time choice. It submits a server
// action (org/user from the session), which redirects back to the tile. No content is ever shown.

import { useState, useTransition } from 'react';
import { SOURCE_CONNECTION_BASELINE_WINDOWS, SOURCE_CONNECTION_BASELINE_DEFAULT_WINDOW_DAYS } from '@emgloop/shared';

import {
  cancelTelegramLoginAction,
  startTelegramLoginAction,
  submitTelegramCodeAction,
  submitTelegramPasswordAction,
  type TelegramLoginResult,
} from '../../../connections/telegram-connect-actions';
import { authorizeBaselineAction, revokeBaselineAction } from '../../../connections/actions';

type Step = 'idle' | 'phone' | 'code' | 'password' | 'baseline' | 'unavailable';

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
        // Signed in. Offer the bounded history-baseline choice before returning to the tile; the
        // chosen server action redirects (a full navigation), so no manual reload is needed here.
        setStep('baseline');
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

  if (step === 'baseline') {
    // A bounded depth chooser. "Import history" submits the chosen window; "Don't import history"
    // revokes (a no-op when nothing was authorized). Both are server actions that redirect back.
    return (
      <form className="loop-stack" action={authorizeBaselineAction}>
        <input type="hidden" name="provider" value="TELEGRAM" />
        <p className="loop-panel__lead" role="status">Signed in. Import a window of past history? Loop reads who and when only — never message contents.</p>
        <fieldset className="loop-stack">
          <legend className="muted">How far back to import</legend>
          {SOURCE_CONNECTION_BASELINE_WINDOWS.map((d) => (
            <label key={d} className="muted">
              <input type="radio" name="windowDays" value={String(d)} defaultChecked={d === SOURCE_CONNECTION_BASELINE_DEFAULT_WINDOW_DAYS} /> Last {d} days
            </label>
          ))}
        </fieldset>
        <div className="loop-btnrow">
          <button className="loop-btn loop-btn--primary" type="submit">Import history</button>
          <button className="loop-btn" type="submit" formAction={revokeBaselineAction}>Don’t import history</button>
        </div>
      </form>
    );
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
