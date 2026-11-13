import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBusinessEnvironment, BUSINESS_CALLBACKS } from '../src/tiktok-business/environment';
const origin = 'https://app.emgloop.com';
const env = {
  TIKTOK_BUSINESS_APP_ID: '12345678', TIKTOK_BUSINESS_APP_SECRET: 'test-secret-value', LOOP_TIKTOK_BUSINESS_TOKEN_KEY: Buffer.alloc(32, 4).toString('base64'),
  TIKTOK_BUSINESS_TTO_AUTHORIZATION_URL: 'https://business-api.tiktok.com/portal/auth?app_id=12345678',
  TIKTOK_BUSINESS_CREATOR_AUTHORIZATION_URL: 'https://www.tiktok.com/v2/auth/authorize/?client_id=12345678',
};
test('business configuration is independent of Login Kit and callbacks are distinct', () => {
  assert.equal(readBusinessEnvironment('TTO', {}, origin), null);
  const a = readBusinessEnvironment('TTO', env, origin)!;
  const b = readBusinessEnvironment('CREATOR', env, origin)!;
  assert.equal(a.redirectUri, origin + BUSINESS_CALLBACKS.TTO);
  assert.equal(b.redirectUri, origin + BUSINESS_CALLBACKS.CREATOR);
  assert.notEqual(a.redirectUri, b.redirectUri);
});
test('wrong app, hostile URL, leaked secrets, partial or malformed settings fail closed', () => {
  for (const template of ['https://business-api.tiktok.com/portal/auth?app_id=87654321', 'https://evil.example/?app_id=12345678', 'https://business-api.tiktok.com/portal/auth?app_id=12345678&auth_code=test', 'https://business-api.tiktok.com/portal/auth?app_id=12345678&client_secret=test']) assert.equal(readBusinessEnvironment('TTO', { ...env, TIKTOK_BUSINESS_TTO_AUTHORIZATION_URL: template }, origin), null);
  assert.equal(readBusinessEnvironment('TTO', { ...env, LOOP_TIKTOK_BUSINESS_TOKEN_KEY: 'invalid' }, origin), null);
  assert.equal(readBusinessEnvironment('TTO', { ...env, TIKTOK_BUSINESS_APP_SECRET: undefined }, origin), null);
});
