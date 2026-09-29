import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { classifyModelError } from '../lambda/shared/claude';

const apiError = (status: number) => Anthropic.APIError.generate(status, undefined, `${status} failed`, new Headers());
const nameOf = (err: unknown) => (err as Error).name;

test('a transient API failure is renamed to the one the pipeline retries', () => {
  // The incident that motivated this: every real key answered 503.
  for (const status of [429, 500, 502, 503, 504, 529]) {
    assert.equal(nameOf(classifyModelError(apiError(status))), 'ModelUnavailable', `status ${status}`);
  }
  assert.equal(nameOf(classifyModelError(new Anthropic.APIConnectionError({ message: 'reset' }))), 'ModelUnavailable');
  // The message survives, so the failed reel still says what happened.
  assert.match((classifyModelError(apiError(503)) as Error).message, /503/);
});

test('a failure a retry cannot fix is left alone, so it is not re-run', () => {
  // A bad key, a bad request or a missing model will fail the same way again,
  // and each retry is another full vision pass.
  for (const status of [400, 401, 403, 404]) {
    assert.notEqual(nameOf(classifyModelError(apiError(status))), 'ModelUnavailable', `status ${status}`);
  }
  const refusal = new Error('the model declined to analyse this reel');
  assert.equal(classifyModelError(refusal), refusal);
});
