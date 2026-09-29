/**
 * Cognito CustomMessage trigger: writes the invite email.
 *
 * The pool's built-in invitation template can substitute only `{username}` and
 * `{####}`, so it cannot greet anyone by name or link to the site. This trigger
 * can, because Cognito hands it the new user's attributes.
 *
 * Cognito still fills in the password itself: the message must contain the
 * `codeParameter` and `usernameParameter` placeholders, and Cognito rejects the
 * whole message (falling back to its default) if either is missing. So the
 * password never passes through this function.
 */

interface CustomMessageEvent {
  triggerSource: string;
  request: {
    userAttributes: Record<string, string>;
    codeParameter: string;
    usernameParameter: string | null;
  };
  response: {
    emailSubject?: string;
    emailMessage?: string;
    smsMessage?: string;
  };
}

const SITE_URL = process.env.SITE_URL ?? '';

export const INVITE_SUBJECT = 'Welcome to Reel Lens. Access your account';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The invite body. HTML, because Cognito sends email as HTML and a plain-text
 * body loses its line breaks.
 *
 * The password sits alone in a monospace block. That is for the reader, since
 * a temporary password is typed or copied character by character. It also
 * gives Gmail less surrounding text to misread as a one-time code: it pulled a
 * stray "8" out of the old one-line body and offered it as "Code Requested".
 */
export function inviteEmail(opts: {
  name?: string;
  usernameParameter: string;
  codeParameter: string;
  siteUrl?: string;
}): string {
  const greeting = opts.name?.trim() ? `Dear ${escapeHtml(opts.name.trim())},` : 'Hello,';
  const signIn = opts.siteUrl
    ? `<p>Sign in at <a href="${escapeHtml(opts.siteUrl)}">${escapeHtml(opts.siteUrl)}</a>.</p>`
    : '';
  // usernameParameter is Cognito's placeholder for the sign-in name. Sign-in is
  // by email here, so it renders as the address; it must appear regardless.
  return [
    `<p>${greeting}</p>`,
    '<p>You have been invited to Reel Lens.</p>',
    '<p>Your registration information:</p>',
    '<table cellpadding="4" style="border-collapse:collapse">',
    `<tr><td>E-mail:</td><td>${opts.usernameParameter}</td></tr>`,
    `<tr><td>Temporary password:</td><td style="font-family:monospace;font-size:16px">${opts.codeParameter}</td></tr>`,
    '</table>',
    signIn,
    '<p>When you sign in for the first time, you will be asked to choose a new password.</p>',
    '<p style="color:#777">This is an automated e-mail, please do not reply.</p>',
  ]
    .filter(Boolean)
    .join('\n');
}

export const main = async (event: CustomMessageEvent): Promise<CustomMessageEvent> => {
  // Only the admin invite (and its resend) is customised; verification codes and
  // password resets keep Cognito's defaults.
  if (event.triggerSource !== 'CustomMessage_AdminCreateUser') return event;

  const attrs = event.request.userAttributes;
  event.response.emailSubject = INVITE_SUBJECT;
  event.response.emailMessage = inviteEmail({
    name: attrs.name,
    usernameParameter: event.request.usernameParameter ?? attrs.email,
    codeParameter: event.request.codeParameter,
    siteUrl: SITE_URL,
  });
  return event;
};
