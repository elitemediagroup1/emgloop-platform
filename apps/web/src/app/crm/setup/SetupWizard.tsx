'use client';

// Sprint 23 — Owner Setup Wizard (client). Final first-run polish.
//
// Five-step, calm/minimal first-login flow. Wizard values live in local React
// state and are carried between steps (no server round-trip per step). Only on
// the final "Enter Loop" does the completion server action persist the mapped
// fields and the onboarding marker, then (after a brief presentational
// "preparing" beat) redirect to the canonical workspace. The profile photo
// area is a clearly labelled placeholder and never pretends to work. This
// sprint changes presentation only: headings, subtitles, step labels, the
// workspace address box, AI relabelling and the celebration/loading finish
// state. No persisted values, fields or schema were changed.

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { completeSetupAction } from './setup-actions';

interface Initial {
  orgName: string;
  orgSlug: string;
  orgEmail: string;
  orgIndustry: string;
  orgTimezone: string;
  userName: string;
  userEmail: string;
  firstName: string;
  lastName: string;
  preferredName: string;
  jobTitle: string;
  userPhone: string;
  userTimezone: string;
}

interface WizardState {
  firstName: string;
  lastName: string;
  preferredName: string;
  jobTitle: string;
  userPhone: string;
  userTimezone: string;
  orgName: string;
  orgWebsite: string;
  orgEmail: string;
  orgPhone: string;
  orgTimezone: string;
  orgIndustry: string;
  companySize: string;
  workspaceName: string;
  landingPage: string;
  theme: string;
  aiPreferredName: string;
  communicationStyle: string;
  decisionStyle: string;
}

const INDUSTRY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'GENERIC', label: 'General' },
  { value: 'HOME_SERVICES', label: 'Home Services' },
  { value: 'MEDICAL', label: 'Medical' },
  { value: 'DENTAL', label: 'Dental' },
  { value: 'LAW_FIRM', label: 'Legal' },
  { value: 'RESTAURANT', label: 'Restaurant' },
  { value: 'AUTOMOTIVE', label: 'Automotive' },
  { value: 'BEAUTY_SPA', label: 'Beauty & Spa' },
  { value: 'FITNESS', label: 'Fitness' },
];

const SIZE_OPTIONS = ['1\u201310', '11\u201350', '51\u2013200', '201\u2013500', '500+'];

const STEP_LABELS = ['Profile', 'Company', 'Workspace', 'AI', 'Finish'];

const Field = ({
  label,
  required,
  children,
  hint,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
  hint?: string;
}) => (
  <label className="loop-setup__field">
    <span className="loop-setup__label">
      {label}
      {required ? <span className="loop-setup__req" aria-hidden="true"> *</span> : null}
    </span>
    {children}
    {hint ? <span className="loop-setup__hint">{hint}</span> : null}
  </label>
);

export function SetupWizard({ initial }: { initial: Initial }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [state, setState] = useState<WizardState>({
    firstName: initial.firstName,
    lastName: initial.lastName,
    preferredName: initial.preferredName,
    jobTitle: initial.jobTitle,
    userPhone: initial.userPhone,
    userTimezone: initial.userTimezone || initial.orgTimezone,
    orgName: initial.orgName,
    orgWebsite: '',
    orgEmail: initial.orgEmail || initial.userEmail,
    orgPhone: '',
    orgTimezone: initial.orgTimezone,
    orgIndustry: initial.orgIndustry,
    companySize: '',
    workspaceName: initial.orgName,
    landingPage: 'dashboard',
    theme: 'system',
    aiPreferredName: initial.preferredName || initial.firstName,
    communicationStyle: 'balanced',
    decisionStyle: 'recommend',
  });

  const set = useCallback(
    <K extends keyof WizardState,>(key: K, value: WizardState[K]) =>
      setState((prev) => ({ ...prev, [key]: value })),
    [],
  );

  const workspaceUrl = useMemo(() => {
    const rawSlug = initial.orgSlug || '';
    const slug = rawSlug.includes('servicesinmycity-demo') ? '' : rawSlug;
    return slug ? 'app.emgloop.com/' + slug : 'app.emgloop.com';
  }, [initial.orgSlug]);

  const totalSteps = STEP_LABELS.length;

  const greeting = state.firstName.trim()
    ? 'Welcome, ' + state.firstName.trim() + '.'
    : 'Welcome to Loop.';

  const canContinue = useMemo(() => {
    if (step === 0) {
      return (
        state.firstName.trim() !== '' &&
        state.lastName.trim() !== '' &&
        state.jobTitle.trim() !== ''
      );
    }
    if (step === 1) {
      return state.orgName.trim() !== '' && state.orgEmail.trim() !== '';
    }
    return true;
  }, [step, state]);

  const goBack = useCallback(() => {
    setError('');
    setStep((s) => Math.max(0, s - 1));
  }, []);

  const goNext = useCallback(() => {
    setError('');
    setStep((s) => Math.min(totalSteps - 1, s + 1));
  }, [totalSteps]);

  // Celebration page primary action. Persists the setup via the completion
  // server action (the only trusted persistence path), then shows a brief
  // "preparing your workspace" beat before navigating to the workspace. The
  // delay is presentational only — no network request is faked.
  const enterLoop = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const fd = new FormData();
      fd.set('firstName', state.firstName);
      fd.set('lastName', state.lastName);
      fd.set('preferredName', state.preferredName);
      fd.set('jobTitle', state.jobTitle);
      fd.set('userPhone', state.userPhone);
      fd.set('userTimezone', state.userTimezone);
      fd.set('orgName', state.orgName);
      fd.set('orgTimezone', state.orgTimezone);
      fd.set('orgIndustry', state.orgIndustry);
      fd.set('orgWebsite', state.orgWebsite);
      fd.set('orgEmail', state.orgEmail);
      fd.set('orgPhone', state.orgPhone);
      fd.set('companySize', state.companySize);
      fd.set('workspaceName', state.workspaceName);
      fd.set('landingPage', state.landingPage);
      fd.set('theme', state.theme);
      fd.set('aiPreferredName', state.aiPreferredName || state.preferredName);
      fd.set('communicationStyle', state.communicationStyle);
      fd.set('decisionStyle', state.decisionStyle);

      const result = await completeSetupAction(fd);
      if (!result.ok) {
        setError(result.message || 'We could not complete setup. Please try again.');
        setSubmitting(false);
        return;
      }
      setTimeout(() => {
        router.push('/crm');
      }, 1000);
    } catch {
      setError('We could not complete setup. Please try again.');
      setSubmitting(false);
    }
  }, [submitting, state, router]);

  return (
    <div className="loop-setup">
      <div className="loop-setup__card" role="group" aria-label="Owner setup">
        <div className="loop-setup__progress" aria-hidden="true">
          <div
            className="loop-setup__progress-bar"
            style={{ width: Math.round(((step + 1) / totalSteps) * 100) + '%' }}
          />
        </div>
        <p className="loop-setup__sr" aria-live="polite">
          Step {step + 1} of {totalSteps}: {STEP_LABELS[step]}
        </p>
        <ol className="loop-setup__steplabels" aria-hidden="true">
          {STEP_LABELS.map((label, i) => (
            <li
              key={label}
              className={
                'loop-setup__steplabel' +
                (i === step ? ' loop-setup__steplabel--active' : '')
              }
            >
              {label}
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <section className="loop-setup__step">
            <p className="loop-setup__sectionlabel">Your Profile</p>
            <h1 className="loop-setup__heading">{greeting}</h1>
            <p className="loop-setup__subtitle">
              Let&apos;s personalize your workspace before we get started.
            </p>

            <div className="loop-setup__photo">
              <div className="loop-setup__avatar" aria-hidden="true">
                {(state.firstName[0] || 'A').toUpperCase()}
              </div>
              <span className="setup-photo-label">
                <span className="setup-photo-label-title">Profile photo</span>
                <span className="setup-photo-label-note">Coming soon</span>
              </span>
            </div>

            <Field label="First name" required>
              <input
                type="text"
                value={state.firstName}
                maxLength={100}
                onChange={(e) => set('firstName', e.target.value)}
              />
            </Field>
            <Field label="Last name" required>
              <input
                type="text"
                value={state.lastName}
                maxLength={100}
                onChange={(e) => set('lastName', e.target.value)}
              />
            </Field>
            <Field label="Preferred name">
              <input
                type="text"
                value={state.preferredName}
                maxLength={100}
                onChange={(e) => set('preferredName', e.target.value)}
              />
            </Field>
            <Field label="Job title" required>
              <input
                type="text"
                value={state.jobTitle}
                maxLength={100}
                onChange={(e) => set('jobTitle', e.target.value)}
              />
            </Field>
            <Field label="Phone">
              <input
                type="tel"
                value={state.userPhone}
                maxLength={40}
                onChange={(e) => set('userPhone', e.target.value)}
              />
            </Field>
          </section>
        ) : null}

        {step === 1 ? (
          <section className="loop-setup__step">
            <h1 className="loop-setup__heading">Your Company</h1>
            <p className="loop-setup__subtitle">
              These details help configure your workspace.
            </p>

            <Field label="Organization name" required>
              <input
                type="text"
                value={state.orgName}
                maxLength={150}
                onChange={(e) => set('orgName', e.target.value)}
              />
            </Field>
            <Field label="Website">
              <input
                type="url"
                value={state.orgWebsite}
                maxLength={200}
                onChange={(e) => set('orgWebsite', e.target.value)}
              />
            </Field>
            <Field label="Primary company email" required>
              <input
                type="email"
                value={state.orgEmail}
                maxLength={254}
                onChange={(e) => set('orgEmail', e.target.value)}
              />
            </Field>
            <Field label="Primary company phone">
              <input
                type="tel"
                value={state.orgPhone}
                maxLength={40}
                onChange={(e) => set('orgPhone', e.target.value)}
              />
            </Field>
            <Field label="Time zone" required>
              <input
                type="text"
                value={state.orgTimezone}
                maxLength={64}
                onChange={(e) => set('orgTimezone', e.target.value)}
              />
            </Field>
            <Field label="Industry" required>
              <select
                value={state.orgIndustry}
                onChange={(e) => set('orgIndustry', e.target.value)}
              >
                {INDUSTRY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Company size" required>
              <select
                value={state.companySize}
                onChange={(e) => set('companySize', e.target.value)}
              >
                <option value="">Select\u2026</option>
                {SIZE_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>
          </section>
        ) : null}

        {step === 2 ? (
          <section className="loop-setup__step">
            <h1 className="loop-setup__heading">Your Workspace</h1>
            <p className="loop-setup__subtitle">
              Choose how you&apos;d like Loop to feel when you sign in.
            </p>

            <Field label="Workspace name">
              <input
                type="text"
                value={state.workspaceName}
                maxLength={150}
                onChange={(e) => set('workspaceName', e.target.value)}
              />
            </Field>

            <div className="loop-setup__field">
              <span className="loop-setup__label">Workspace Address</span>
              <div className="loop-setup__addressbox">
                <span className="loop-setup__addresstext">{workspaceUrl}</span>
                <span className="loop-setup__copyicon" aria-hidden="true" title="Copy">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
                    <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
                    <path d="M5 15V6a2 2 0 0 1 2-2h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </span>
              </div>
            </div>

            <Field label="Start Page">
              <select
                value={state.landingPage}
                onChange={(e) => set('landingPage', e.target.value)}
              >
                <option value="dashboard">Dashboard</option>
                <option value="crm">CRM</option>
                <option value="work">Work</option>
              </select>
            </Field>
            <Field label="Appearance">
              <select value={state.theme} onChange={(e) => set('theme', e.target.value)}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">System</option>
              </select>
            </Field>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="loop-setup__step">
            <h1 className="loop-setup__heading">Meet your AI Assistant</h1>
            <p className="loop-setup__subtitle">
              Tell Loop how you&apos;d like it to work with you.
            </p>

            <Field label="Preferred name for AI">
              <input
                type="text"
                value={state.aiPreferredName}
                maxLength={100}
                onChange={(e) => set('aiPreferredName', e.target.value)}
              />
            </Field>
            <Field label="AI Personality">
              <select
                value={state.communicationStyle}
                onChange={(e) => set('communicationStyle', e.target.value)}
              >
                <option value="concise">Professional</option>
                <option value="balanced">Balanced</option>
                <option value="detailed">Friendly</option>
              </select>
            </Field>
            <Field label="Decision Support">
              <select
                value={state.decisionStyle}
                onChange={(e) => set('decisionStyle', e.target.value)}
              >
                <option value="recommend">Recommend actions</option>
                <option value="execute">Present options</option>
                <option value="challenge">Ask before acting</option>
              </select>
            </Field>
          </section>
        ) : null}

        {step === 4 ? (
          <section className="loop-setup__step loop-setup__step--ready">
            <div className="loop-setup__check-circle" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="40" height="40" fill="none">
                <path
                  d="M5 12.5l4.2 4.2L19 7"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <h1 className="loop-setup__heading loop-setup__heading--celebrate">
              You&apos;re all set.
            </h1>
            <p className="loop-setup__subtitle">Loop is ready.</p>
            <p className="loop-setup__body">
              Your workspace has been created and your operating system is ready to go.
            </p>

            {error ? (
              <p className="loop-setup__error" role="alert">{error}</p>
            ) : null}

            <div className="loop-setup__actions loop-setup__actions--center">
              <button
                type="button"
                className="loop-setup__continue"
                onClick={enterLoop}
                disabled={submitting}
              >
                {submitting ? (
                  <span className="loop-setup__btnloading">
                    <span className="loop-setup__spinner" aria-hidden="true" />
                    Preparing your workspace\u2026
                  </span>
                ) : (
                  'Enter Loop'
                )}
              </button>
            </div>
            <button
              type="button"
              className="loop-setup__textlink"
              onClick={() => router.push('/crm/settings')}
              disabled={submitting}
            >
              Review settings later
            </button>
          </section>
        ) : null}

        {step < 4 ? (
          <>
            {error ? (
              <p className="loop-setup__error" role="alert">{error}</p>
            ) : null}

            <div className="loop-setup__actions">
              {step > 0 ? (
                <button
                  type="button"
                  className="loop-setup__back"
                  onClick={goBack}
                >
                  Back
                </button>
              ) : (
                <span />
              )}

              <button
                type="button"
                className="loop-setup__continue"
                onClick={goNext}
                disabled={!canContinue}
              >
                Continue
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
