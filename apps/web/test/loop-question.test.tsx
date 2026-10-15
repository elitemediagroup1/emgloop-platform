import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLoopQuestion, type QuestionHandlerPorts } from '../src/ai/loop-question-handler';

const url = 'https://app.example.com/api/intelligence/question';
const req = (body: unknown, origin = 'https://app.example.com') =>
  new Request(url, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const principal = { organizationId: 'our-org', userId: 'our-user' };
function ports() {
  const calls: unknown[] = [];
  const p: QuestionHandlerPorts = {
    session: async () => principal,
    mayRead: async () => true,
    answer: async (...args) => {
      calls.push(args);
      return { outcome: 'ANSWERED' };
    },
  };
  return { p, calls };
}
test('foreign org and user in JSON cannot change the signed principal; only bounded question inputs cross the boundary', async () => {
  const { p, calls } = ports();
  const r = await handleLoopQuestion(
    req({
      organizationId: 'victim',
      userId: 'victim-user',
      question: 'What needs me?',
      previousQuestions: ['one', 3, ...Array(8).fill('bounded')],
      page: '/app',
    }),
    p,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(calls, [
    [principal, 'What needs me?', { previousQuestions: Array(4).fill('bounded'), page: '/app' }],
  ]);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
});
test('no evidence read or model call without a session, permission and same-origin request', async () => {
  for (const mode of ['anonymous', 'denied', 'cross-origin', 'missing-origin']) {
    const { p, calls } = ports();
    if (mode === 'anonymous') p.session = async () => null;
    if (mode === 'denied') p.mayRead = async () => false;
    const response = await handleLoopQuestion(
      req(
        { question: 'read everything' },
        mode === 'cross-origin'
          ? 'https://evil.example'
          : mode === 'missing-origin'
            ? ''
            : 'https://app.example.com',
      ),
      p,
    );
    assert.equal(response.status, mode === 'anonymous' ? 401 : 403);
    assert.deepEqual(calls, []);
  }
});
test('malformed, oversized and empty requests fail before the answer service, and failures never disclose exception text', async () => {
  for (const body of [
    null,
    [],
    {},
    { question: '' },
    { question: 'a'.repeat(2001) },
    { question: 'ok', padding: 'a'.repeat(13000) },
  ]) {
    const { p, calls } = ports();
    assert.ok((await handleLoopQuestion(req(body), p)).status >= 400);
    assert.deepEqual(calls, []);
  }
  const { p } = ports();
  p.answer = async () => {
    throw new Error('secret credential');
  };
  const response = await handleLoopQuestion(req({ question: 'Hello' }), p);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /secret credential/);
});


test('Netlify internal URL uses the forwarded public origin without allowing unrelated origins or malformed proxy headers', async () => {
  const forwarded = (over: Record<string, string> = {}) => new Request('http://localhost:3000/api/intelligence/question', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.example.com', 'x-forwarded-host': 'app.example.com', 'x-forwarded-proto': 'https', ...over }, body: JSON.stringify({ question: 'What needs me?' }),
  });
  const { p, calls } = ports();
  assert.equal((await handleLoopQuestion(forwarded(), p)).status, 200);
  assert.equal(calls.length, 1);
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: 'https://app.example.com/extra' }, { 'x-forwarded-host': 'app.example.com,evil.example' }, { 'x-forwarded-host': 'app.example.com@evil.example' }, { 'x-forwarded-proto': 'https,http' }, { origin: 'http://app.example.com' }]) {
    const denied = ports();
    assert.equal((await handleLoopQuestion(forwarded(headers), denied.p)).status, 403);
    assert.deepEqual(denied.calls, []);
  }
});
