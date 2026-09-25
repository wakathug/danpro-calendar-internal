import assert from 'node:assert/strict';
import test from 'node:test';
import calendarHandler from '../api/calendar.js';
import logoutHandler from '../api/auth/logout.js';
import sessionHandler from '../api/auth/session.js';
import { createSession, SESSION_COOKIE } from '../api/_lib/session.js';
import {
  configureTestEnvironment,
  MemoryStore,
  mockRequest,
  mockResponse,
} from './helpers.js';

configureTestEnvironment();

let store;
let originalFetch;

test.beforeEach(() => {
  store = new MemoryStore();
  globalThis.__DANPRO_TEST_STORE__ = store;
  originalFetch = globalThis.fetch;
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.__DANPRO_TEST_STORE__;
});

function cookieHeader(cookie) {
  return cookie.split(';')[0];
}

function gasResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('unauthenticated employee API is 401 and never contacts Apps Script', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('unexpected'); };
  const response = mockResponse();
  await calendarHandler(mockRequest(), response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, 'UNAUTHENTICATED');
  assert.equal(fetchCalls, 0);
  assert.equal(response.getHeader('cache-control'), 'private, no-store, max-age=0');
});

test('authorized employee session and calendar requests return 200 with no shared cache', async () => {
  const created = await createSession('employee@example.com', Date.now());
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.action === 'authorize') return gasResponse({ ok: true, data: { authorized: true } });
    return gasResponse({ ok: true, data: { days: [], levels: [], updatedAt: '2026-09-25T00:00:00.000Z' } });
  };

  const sessionResponse = mockResponse();
  await sessionHandler(mockRequest({ headers: { cookie: cookieHeader(created.cookie) } }), sessionResponse);
  assert.equal(sessionResponse.statusCode, 200);
  assert.deepEqual(sessionResponse.json(), { authenticated: true });

  const calendarResponse = mockResponse();
  await calendarHandler(mockRequest({ headers: { cookie: cookieHeader(created.cookie) } }), calendarResponse);
  assert.equal(calendarResponse.statusCode, 200);
  assert.equal(calendarResponse.json().ok, true);
  assert.equal(calendarResponse.getHeader('cache-control'), 'private, no-store, max-age=0');
  assert.equal(calendarResponse.getHeader('cache-control').includes('s-maxage'), false);
});

test('permission removal invalidates an existing server-side session on next check', async () => {
  const created = await createSession('employee@example.com', Date.now());
  globalThis.fetch = async () => gasResponse({ ok: true, data: { authorized: true } });
  const first = mockResponse();
  await sessionHandler(mockRequest({ headers: { cookie: cookieHeader(created.cookie) } }), first);
  assert.equal(first.statusCode, 200);

  globalThis.fetch = async () => gasResponse({ ok: false, error: 'ACCESS_DENIED' });
  const denied = mockResponse();
  await sessionHandler(mockRequest({ headers: { cookie: cookieHeader(created.cookie) } }), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().authenticated, false);
  const sessionId = cookieHeader(created.cookie).split('=')[1];
  const storedKeys = [...store.values.keys()].filter((key) => key.startsWith('session:v1:'));
  assert.equal(storedKeys.length, 0, `session ${sessionId.length} chars should be deleted`);
});

test('logout is POST-only, requires exact Origin, deletes store session, and clears cookie', async () => {
  const created = await createSession('employee@example.com', Date.now());
  const cookie = cookieHeader(created.cookie);

  const noOrigin = mockResponse();
  await logoutHandler(mockRequest({ method: 'POST', headers: { cookie } }), noOrigin);
  assert.equal(noOrigin.statusCode, 403);

  const response = mockResponse();
  await logoutHandler(mockRequest({
    method: 'POST',
    headers: {
      cookie,
      origin: process.env.APP_ORIGIN,
      host: 'danpro-calendar-internal.vercel.app',
      'x-forwarded-proto': 'https',
    },
  }), response);
  assert.equal(response.statusCode, 204);
  assert.match(response.getHeader('set-cookie'), /Max-Age=0/);
  assert.equal([...store.values.keys()].filter((key) => key.startsWith('session:v1:')).length, 0);

  const getResponse = mockResponse();
  await logoutHandler(mockRequest({ method: 'GET' }), getResponse);
  assert.equal(getResponse.statusCode, 405);
});

test('session cookie has required __Host attributes and contains only opaque id', async () => {
  const created = await createSession('employee@example.com', Date.now());
  assert.match(created.cookie, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43};`));
  assert.match(created.cookie, /; Path=\//);
  assert.match(created.cookie, /; HttpOnly/);
  assert.match(created.cookie, /; Secure/);
  assert.match(created.cookie, /; SameSite=Lax/);
  assert.doesNotMatch(created.cookie, /Domain=/i);
  assert.doesNotMatch(created.cookie, /employee|example\.com/i);
  assert.equal(created.session.expiresAt - created.session.createdAt, 7 * 24 * 60 * 60 * 1000);
});
