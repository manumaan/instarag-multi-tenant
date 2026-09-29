import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INVITE_SUBJECT, inviteEmail, main } from '../lambda/auth/invite-message';

const event = (triggerSource: string, userAttributes: Record<string, string>) => ({
  triggerSource,
  request: { userAttributes, codeParameter: '{####}', usernameParameter: '{username}' },
  response: {} as { emailSubject?: string; emailMessage?: string },
});

test('the invite keeps both placeholders, or Cognito discards it for its default', async () => {
  const out = await main(event('CustomMessage_AdminCreateUser', { email: 'a@b.co', name: 'Nithya' }));
  assert.equal(out.response.emailSubject, INVITE_SUBJECT);
  assert.match(out.response.emailMessage!, /\{####\}/);
  assert.match(out.response.emailMessage!, /\{username\}/);
  assert.match(out.response.emailMessage!, /Dear Nithya,/);
});

test('an invite with no name still reads as a greeting', () => {
  const body = inviteEmail({ usernameParameter: '{username}', codeParameter: '{####}' });
  assert.match(body, /<p>Hello,<\/p>/);
  assert.doesNotMatch(body, /Dear/);
});

test('a name is escaped, since an admin typed it into HTML', () => {
  const body = inviteEmail({ name: '<b>x</b>', usernameParameter: 'u', codeParameter: 'c' });
  assert.doesNotMatch(body, /<b>x<\/b>/);
});

test('other Cognito messages keep their defaults', async () => {
  for (const source of ['CustomMessage_ForgotPassword', 'CustomMessage_VerifyUserAttribute']) {
    const out = await main(event(source, { email: 'a@b.co' }));
    assert.deepEqual(out.response, {});
  }
});
