// Transactional email templates for EMG Loop.
//
// No template framework: plain functions returning { subject, html, text }.
// Keep these minimal, professional, and easy to maintain. Never embed secrets
// here; URLs are passed in by the caller.

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const BRAND = 'EMG Loop';

function shell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933;">
    <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
      <div style="background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e4e7eb;">
        <h1 style="margin:0 0 16px;font-size:20px;color:#111827;">${title}</h1>
        ${bodyHtml}
        <hr style="border:none;border-top:1px solid #e4e7eb;margin:28px 0;" />
        <p style="margin:0;font-size:13px;color:#6b7280;">&mdash; The ${BRAND} Team</p>
      </div>
    </div>
  </body>
</html>`;
}

function button(url: string, label: string): string {
  return `<p style="margin:24px 0;">
    <a href="${url}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;">${label}</a>
  </p>`;
}

function rawUrlFallback(url: string): string {
  return `<p style="margin:16px 0 0;font-size:13px;color:#6b7280;">
    If the button does not work, copy and paste this link into your browser:<br />
    <span style="word-break:break-all;color:#4f46e5;">${url}</span>
  </p>`;
}

export function inviteTemplate(params: { name?: string; inviteUrl: string }): RenderedEmail {
  const greeting = params.name ? `Hi ${params.name},` : 'Hi,';
  const subject = "You've been invited to EMG Loop";
  const html = shell(
    "You've been invited to EMG Loop",
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;">${greeting}</p>
     <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">
       You have been invited to join ${BRAND}, the operating system for running the business.
       Click below to accept your invitation and set up your account.
     </p>
     ${button(params.inviteUrl, 'Accept Invitation')}
     ${rawUrlFallback(params.inviteUrl)}
     <p style="margin:20px 0 0;font-size:13px;color:#6b7280;">
       For your security, this invitation link is unique to you. If you were not
       expecting this invitation, you can safely ignore this email.
     </p>`,
  );
  const text = [
    greeting,
    '',
    "You have been invited to join " + BRAND + ".",
    'Accept your invitation and set up your account using the link below:',
    '',
    params.inviteUrl,
    '',
    'This invitation link is unique to you. If you were not expecting it, you can safely ignore this email.',
    '',
    '- The ' + BRAND + ' Team',
  ].join('\n');
  return { subject, html, text };
}

export function passwordResetTemplate(params: { name?: string; resetUrl: string }): RenderedEmail {
  const greeting = params.name ? `Hi ${params.name},` : 'Hi,';
  const subject = 'Reset your EMG Loop password';
  const html = shell(
    'Reset your EMG Loop password',
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;">${greeting}</p>
     <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">
       We received a request to reset the password for your ${BRAND} account.
       Click below to choose a new password.
     </p>
     ${button(params.resetUrl, 'Reset Password')}
     ${rawUrlFallback(params.resetUrl)}
     <p style="margin:20px 0 0;font-size:13px;color:#6b7280;">
       If you did not request a password reset, you can safely ignore this email &mdash;
       your password will stay the same.
     </p>`,
  );
  const text = [
    greeting,
    '',
    'We received a request to reset the password for your ' + BRAND + ' account.',
    'Choose a new password using the link below:',
    '',
    params.resetUrl,
    '',
    'If you did not request this, you can safely ignore this email; your password will stay the same.',
    '',
    '- The ' + BRAND + ' Team',
  ].join('\n');
  return { subject, html, text };
}

/**
 * Internal notification for a public "Request Access" submission.
 *
 * Sent to the EMG operations inbox so a human can review and, if approved,
 * issue an invitation through the existing admin flow. Contains only the
 * values the requester submitted (already validated + normalized server-side).
 * All interpolated values are HTML-escaped to avoid markup injection.
 */
export function accessRequestTemplate(params: {
  fullName: string;
  email: string;
  company: string;
  accessType: string;
  submittedAt: Date;
}): RenderedEmail {
  const esc = (value: string): string =>
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const submitted = params.submittedAt.toISOString().replace('T', ' ').replace(/\..+/, ' UTC');

  const nextStep =
    'Review this request in EMG operations. If approved, create or invite the ' +
    'user through Loop\u2019s existing administration flow so Loop sends the ' +
    'secure invitation link.';

  const bodyHtml =
    '<table style="border-collapse:collapse;font-size:14px;line-height:1.6;">' +
    '<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Full name</td><td>' + esc(params.fullName) + '</td></tr>' +
    '<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Work email</td><td>' + esc(params.email) + '</td></tr>' +
    '<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Company or organization</td><td>' + esc(params.company) + '</td></tr>' +
    '<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Requested access</td><td>' + esc(params.accessType) + '</td></tr>' +
    '<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Submitted</td><td>' + esc(submitted) + '</td></tr>' +
    '</table>' +
    '<p style="font-size:13px;color:#6b7280;margin:20px 0 0;">' + esc(nextStep) + '</p>';

  const text =
    'New Loop Access Request\n\n' +
    'Full name:\n' + params.fullName + '\n\n' +
    'Work email:\n' + params.email + '\n\n' +
    'Company or organization:\n' + params.company + '\n\n' +
    'Requested access:\n' + params.accessType + '\n\n' +
    'Submitted:\n' + submitted + '\n\n' +
    nextStep + '\n';

  return {
    subject: 'Loop access request \u2014 ' + params.accessType + ' \u2014 ' + params.fullName,
    html: shell('New Loop Access Request', bodyHtml),
    text,
  };
}
