'use client';

// Sprint 21 — Owner Setup Wizard (client).
//
// Six-step, calm/minimal first-login flow. Wizard values live in local React
// state and are carried between steps (no server round-trip per step). Only on
// the final "Enter Loop" does the completion server action persist the mapped
// fields and the onboarding marker, then redirect to the canonical workspace.
// Placeholders (profile photo upload, connected services) are clearly labelled
// and never pretend to work.

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { completeSetupAction } from './setup-actions';

interface Initial {
  orgName: string;
  orgSlug: string;
  orgIndustry: string;
  orgTimezone: string;
  userName: string;
  userEmail: string;
}

interface WizardState {
  // Step 1 — profile (persisted to User.metadata.profile; phone to User.phone)
  firstName: string;
  lastName: string;
  preferredName: string;
  jobTitle: string;
  company: string;
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
  // Step 5 — AI preferences (-> settings.aiPreferences)
  aiPreferredName: string;
  communicationStyle: string;
  decisionStyle: string;
  dailyBrief: boolean;
  weeklySummary: boolean;
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

const SIZE_OPTIONS = ['1–10', '11–50', '51–200', '201–500', '500+'];

const STEP_TITLES = [
  'Your profile',
  'Organization',
  'Your workspace',
  'Connected services',
  'AI preferences',
  'Ready',
];

export function SetupWizard({ initial }: { initial: Initial }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const [state, setState] = useState<WizardState>({
    firstName: '',
    lastName: '',
    preferredName: '',
    jobTitle: '',
    company: initial.orgName,
    userPhone: '',
    userTimezone: initial.orgTimezone,
    orgName: initial.orgName,
    orgWebsite: '',
    orgEmail: initial.userEmail,
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
    dailyBrief: true,
    weeklySummary: true,
  });

  const set = useCallback(
    <K extends keyof WizardState,>(key: K, value: WizardState[K]) =>
      setState((prev) => ({ ...prev, [key]: value })),
    [],
  );

  const workspaceUrl = useMemo(
    () => 'app.emgloop.com/' + (initial.orgSlug || 'workspace'),
    [initial.orgSlug],
  );

  const totalSteps = STEP_TITLES.length;
  const progress = Math.round(((step + 1) / totalSteps) * 100);

  // Step 1 requires first/last/job title/company. Step 2 requires org name +
  // primary email. All other steps may continue freely.
  const canContinue = useMemo(() => {
    if (step === 0) {
      return (
        state.firstName.trim() !== '' &&
        state.lastName.trim() !== '' &&
        state.jobTitle.trim() !== '' &&
        state.company.trim() !== ''
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
      if (state.dailyBrief) fd.set('dailyBrief', 'on');
      if (state.weeklySummary) fd.set('weeklySummary', 'on');

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

  return (
    <div className="loop-setup">
      <div className="loop-setup__card" role="group" aria-label="Owner setup">
        {!done ? (
          <>
            <div className="loop-setup__progress" aria-hidden="true">
              <div className="loop-setup__progress-bar" style={{ width: progress + '%' }} />
            </div>
            <p className="loop-setup__stepindicator">
              Step {step + 1} of {totalSteps} · {STEP_TITLES[step]}
            </p>

            {step === 0 ? (
              <section className="loop-setup__step">
                <h1 className="loop-setup__heading">Welcome to Loop</h1>
                <p className="loop-setup__subtitle">Let&apos;s start by setting up your profile.</p>

                <div className="loop-setup__photo">
                  <div className="loop-setup__avatar" aria-hidden="true">
                    {(state.firstName[0] || 'A').toUpperCase()}
                  </div>
                  <span className="loop-setup__photonote">
                    Profile photo upload is coming soon.
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
                <Field label="Company" required>
                  <input
                    type="text"
                    value={state.company}
                    maxLength={150}
                    onChange={(e) => set('company', e.target.value)}
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
                <h1 className="loop-setup__heading">Tell us about your organization</h1>

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
                <Field label="Primary email" required>
                  <input
                    type="email"
                    value={state.orgEmail}
                    maxLength={254}
                    onChange={(e) => set('orgEmail', e.target.value)}
                  />
                </Field>
                <Field label="Primary phone">
                  <input
                    type="tel"
                    value={state.orgPhone}
                    maxLength={40}
                    onChange={(e) => set('orgPhone', e.target.value)}
                  />
                </Field>
                <Field label="Time zone">
                  <input
                    type="text"
                    value={state.orgTimezone}
                    maxLength={64}
                    onChange={(e) => set('orgTimezone', e.target.value)}
                  />
                </Field>
                <div className="loop-setup__field">
                  <span className="loop-setup__label">Company logo</span>
                  <div className="loop-setup__logoph" aria-hidden="true">Logo upload coming soon</div>
                </div>
                <Field label="Industry">
                  <select
                    value={state.orgIndustry}
                    onChange={(e) => set('orgIndustry', e.target.value)}
                  >
                    {INDUSTRY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Company size">
                  <select
                    value={state.companySize}
                    onChange={(e) => set('companySize', e.target.value)}
                  >
                    <option value="">Select…</option>
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
                <h1 className="loop-setup__heading">Connect your business tools</h1>
                <div className="loop-setup__services">
                  {[
                    'Google Workspace',
                    'Microsoft 365',
                    'Slack',
                    'HubSpot',
                  ].map((name) => (
                    <div key={name} className="loop-setup__service">
                      <div className="loop-setup__service-head">
                        <span className="loop-setup__service-name">{name}</span>
                        <span className="loop-setup__badge">Not connected</span>
                      </div>
                      <button type="button" className="loop-setup__connect" disabled>
                        Connect
                      </button>
                      <span className="loop-setup__soon">Coming soon</span>
                    </div>
                  ))}
                </div>
                <p className="loop-setup__note">
                  You&apos;ll be able to connect these services after setup.
                </p>
              </section>
            ) : null}

            {step === 4 ? (
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
                <label className="loop-setup__check">
                  <input
                    type="checkbox"
                    checked={state.dailyBrief}
                    onChange={(e) => set('dailyBrief', e.target.checked)}
                  />
                  <span>Daily executive brief</span>
                </label>
                <label className="loop-setup__check">
                  <input
                    type="checkbox"
                    checked={state.weeklySummary}
                    onChange={(e) => set('weeklySummary', e.target.checked)}
                  />
                  <span>Weekly executive summary</span>
                </label>
              </section>
            ) : null}

            {step === 5 ? (
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
                <h1 className="loop-setup__heading">Your workspace is ready.</h1>
                <p className="loop-setup__subtitle">Loop has everything it needs to begin.</p>
                <p className="loop-setup__body">
                  You can now begin inviting employees, connecting services, and
                  managing your business.
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
                  {submitting ? 'Finishing…' : 'Enter Loop'}
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
            <h1 className="loop-setup__heading">Your workspace is ready.</h1>
            <p className="loop-setup__subtitle">Loop has everything it needs to begin.</p>
            <div className="loop-setup__actions loop-setup__actions--center">
              <button
                type="button"
                className="loop-setup__secondary"
                onClick={() => router.push('/crm/settings')}
              >
                Review settings
              </button>
              <button
                type="button"
                className="loop-setup__continue"
                onClick={() => router.push('/crm')}
              >
                Enter Loop
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
