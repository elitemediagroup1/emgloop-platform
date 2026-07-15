'use client';

// Sprint 22 — Owner Setup Wizard (client).
//
// Five-step, calm/minimal first-login flow. Wizard values live in local React
// state and are carried between steps (no server round-trip per step). Only on
// the final "Enter Loop" does the completion server action persist the mapped
// fields and the onboarding marker, then redirect to the canonical workspace.
// The profile photo area is a clearly labelled placeholder and never pretends
// to work.

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
  // Step 1 — profile (persisted to User.metadata.profile; phone to User.phone)
  firstName: string;
  lastName: string;
  preferredName: string;
  jobTitle: string;
  userPhone: string;
  userTimezone: string;
  // Step 2 — organization (name/industry/timezone -> columns; rest -> settings)
  orgName: string;
  orgWebsite: string;
  orgEmail: string;
  orgPhone: string;
  orgTimezone: string;
  orgIndustry: string;
  companySize: string;
  // Step 3 — workspace (-> settings.workspace)
  workspaceName: string;
  landingPage: string;
  theme: string;
  // Step 4 — AI preferences (-> settings.aiPreferences)
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

const STEP_TITLES = [
  'Your profile',
  'Organization',
  'Your workspace',
  'AI preferences',
  'Ready',
];

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
  const [done, setDone] = useState(false);

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
    aiPreferredName: '',
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

  const totalSteps = STEP_TITLES.length;
  const progress = Math.round(((step + 1) / totalSteps) * 100);

  // Step 1 requires first/last/job title. Step 2 requires org name + primary
  // email. All other steps may continue freely.
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

  const handleComplete = useCallback(async () => {
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
      if (result.ok) {
        setDone(true);
      } else {
        setError(result.message || 'We could not complete setup. Please try again.');
      }
    } catch {
      setError('We could not complete setup. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [state]);

  return (
    <div className="loop-setup">
      <div className="loop-setup__card" role="group" aria-label="Owner setup">
        {!done ? (
          <>
            <div className="loop-setup__progress" aria-hidden="true">
              <div className="loop-setup__progress-bar" style={{ width: progress + '%' }} />
            </div>
            <p className="loop-setup__stepindicator">
              Step {step + 1} of {totalSteps} \u00B7 {STEP_TITLES[step]}
            </p>

            {step === 0 ? (
              <section className="loop-setup__step">
                <h1 className="loop-setup__heading">Welcome to Loop</h1>
                <p className="loop-setup__subtitle">Let&apos;s start by setting up your profile.</p>

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
                <h1 className="loop-setup__heading">Tell us about your company</h1>

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
                <h1 className="loop-setup__heading">Configure your workspace</h1>

                <Field label="Workspace name">
                  <input
                    type="text"
                    value={state.workspaceName}
                    maxLength={150}
                    onChange={(e) => set('workspaceName', e.target.value)}
                  />
                </Field>
                <Field label="Workspace URL" hint="Your workspace address is set automatically.">
                  <input type="text" value={workspaceUrl} readOnly aria-readonly="true" />
                </Field>
                <Field label="Default landing page">
                  <select
                    value={state.landingPage}
                    onChange={(e) => set('landingPage', e.target.value)}
                  >
                    <option value="dashboard">Dashboard</option>
                    <option value="crm">CRM</option>
                    <option value="work">Work</option>
                  </select>
                </Field>
                <Field label="Theme">
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
                <h1 className="loop-setup__heading">How should Loop work with you?</h1>

                <Field label="Preferred name for AI">
                  <input
                    type="text"
                    value={state.aiPreferredName || state.preferredName}
                    maxLength={100}
                    onChange={(e) => set('aiPreferredName', e.target.value)}
                  />
                </Field>
                <Field label="Communication style">
                  <select
                    value={state.communicationStyle}
                    onChange={(e) => set('communicationStyle', e.target.value)}
                  >
                    <option value="concise">Concise</option>
                    <option value="balanced">Balanced</option>
                    <option value="detailed">Detailed</option>
                  </select>
                </Field>
                <Field label="Decision style">
                  <select
                    value={state.decisionStyle}
                    onChange={(e) => set('decisionStyle', e.target.value)}
                  >
                    <option value="execute">Just execute</option>
                    <option value="recommend">Offer recommendations</option>
                    <option value="challenge">Challenge my thinking</option>
                  </select>
                </Field>
              </section>
            ) : null}

            {step === 4 ? (
              <section className="loop-setup__step loop-setup__step--ready">
                <div className="loop-setup__check-circle" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="34" height="34" fill="none">
                    <path
                      d="M5 12.5l4.2 4.2L19 7"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <h1 className="loop-setup__heading">You&apos;re ready to use Loop.</h1>
                <p className="loop-setup__subtitle">
                  Your workspace has been created and your organization is ready.
                </p>
              </section>
            ) : null}

            {error ? (
              <p className="loop-setup__error" role="alert">{error}</p>
            ) : null}

            <div className="loop-setup__actions">
              {step > 0 ? (
                <button
                  type="button"
                  className="loop-setup__back"
                  onClick={goBack}
                  disabled={submitting}
                >
                  Back
                </button>
              ) : (
                <span />
              )}

              {step < totalSteps - 1 ? (
                <button
                  type="button"
                  className="loop-setup__continue"
                  onClick={goNext}
                  disabled={!canContinue}
                >
                  Continue
                </button>
              ) : (
                <button
                  type="button"
                  className="loop-setup__continue"
                  onClick={handleComplete}
                  disabled={submitting}
                >
                  {submitting ? 'Finishing\u2026' : 'Enter Loop'}
                </button>
              )}
            </div>
          </>
        ) : (
          <section className="loop-setup__step loop-setup__step--ready">
            <div className="loop-setup__check-circle" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="34" height="34" fill="none">
                <path
                  d="M5 12.5l4.2 4.2L19 7"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <h1 className="loop-setup__heading">You&apos;re ready to use Loop.</h1>
            <p className="loop-setup__subtitle">
              Your workspace has been created and your organization is ready.
            </p>
            <div className="loop-setup__actions loop-setup__actions--center">
              <button
                type="button"
                className="loop-setup__continue"
                onClick={() => router.push('/crm')}
              >
                Enter Loop
              </button>
            </div>
            <button
              type="button"
              className="loop-setup__textlink"
              onClick={() => router.push('/crm/settings')}
            >
              Review settings later
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
