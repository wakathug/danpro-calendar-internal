import assert from 'node:assert/strict';
import test from 'node:test';
import calendarHandler from '../api/calendar.js';
import bootstrapHandler from '../api/bootstrap.js';
import dayDetailsHandler from '../api/day-details.js';
import logoutHandler from '../api/auth/logout.js';
import sessionHandler from '../api/auth/session.js';
import {
  createSession,
  deleteSession,
  readSession,
  SESSION_COOKIE,
  updateSessionAuthorization,
} from '../api/_lib/session.js';
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

function detailedGasTiming(overrides = {}) {
  return {
    requestParseMs: 1,
    timestampValidationMs: 1,
    signingSecretReadMs: 1,
    bodyDigestMs: 1,
    hmacComputeMs: 1,
    signatureCompareMs: 1,
    nonceLockWaitMs: 1,
    nonceLookupMs: 1,
    nonceWriteMs: 1,
    drivePermissionsReadMs: 1,
    groupExpansionMs: 0,
    accessPolicyBuildMs: 1,
    employeeMembershipMatchMs: 1,
    calendarAggregateReadMs: 1,
    responseSerializeMs: 1,
    gasAppTotalMs: 20,
    gasUnattributedMs: 7,
    ...overrides,
  };
}

test('unauthenticated employee API is 401 and never contacts Apps Script', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('unexpected'); };
  const response = mockResponse();
  await calendarHandler(mockRequest(), response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, 'UNAUTHENTICATED');
  assert.match(response.getHeader('set-cookie'), /Max-Age=0/);
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
  assert.equal(sessionResponse.json().authenticated, true);
  assert.match(sessionResponse.json().userCacheKey, /^[A-Za-z0-9_-]{43}$/);

  const calendarResponse = mockResponse();
  await calendarHandler(mockRequest({ headers: { cookie: cookieHeader(created.cookie) } }), calendarResponse);
  assert.equal(calendarResponse.statusCode, 200);
  assert.equal(calendarResponse.json().ok, true);
  assert.equal(calendarResponse.getHeader('cache-control'), 'private, no-store, max-age=0');
  assert.equal(calendarResponse.getHeader('cache-control').includes('s-maxage'), false);
});

test('59-second authorization grace validates the session without contacting Apps Script', async () => {
  const now = 1_800_000_000_000;
  const created = await createSession('employee@example.com', now - 5_000, {
    lastAuthorizedAt: now - 59_000,
  });
  const originalDateNow = Date.now;
  let fetchCalls = 0;
  Date.now = () => now;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('unexpected GAS call'); };
  try {
    const response = mockResponse();
    await sessionHandler(
      mockRequest({ headers: { cookie: cookieHeader(created.cookie) } }),
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().authorization.revalidated, false);
    assert.equal(response.json().authorization.validForMs, 1_000);
    assert.doesNotMatch(response.body, /lastAuthorizedAt|employee@example\.com|session:v1:/);
    assert.equal(response.getHeader('cache-control'), 'private, no-store, max-age=0');
    assert.equal(fetchCalls, 0);
  } finally {
    Date.now = originalDateNow;
  }
});

test('authorization grace expires at 60 seconds and requires synchronous GAS authorization', async () => {
  const now = 1_800_000_000_000;
  const created = await createSession('employee@example.com', now - 5_000, {
    lastAuthorizedAt: now - 60_000,
  });
  const originalDateNow = Date.now;
  let fetchCalls = 0;
  Date.now = () => now;
  globalThis.fetch = async (_url, options) => {
    fetchCalls += 1;
    assert.equal(JSON.parse(options.body).action, 'authorize');
    return gasResponse({ ok: true, data: { authorized: true } });
  };
  try {
    const response = mockResponse();
    await sessionHandler(
      mockRequest({ headers: { cookie: cookieHeader(created.cookie) } }),
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().authorization.revalidated, true);
    assert.equal(response.json().authorization.validForMs, 60_000);
    assert.equal(fetchCalls, 1);
    const stored = await readSession(
      mockRequest({ headers: { cookie: cookieHeader(created.cookie) } }),
      now,
    );
    assert.equal(stored.session.lastAuthorizedAt, now);
  } finally {
    Date.now = originalDateNow;
  }
});

test('authorization timestamps only move forward and cannot recreate a deleted session', async () => {
  const now = 1_800_000_000_000;
  const created = await createSession('employee@example.com', now - 5_000, {
    lastAuthorizedAt: now - 4_000,
  });
  assert.equal(await updateSessionAuthorization(created.sessionId, now - 1_000, now), now - 1_000);
  assert.equal(await updateSessionAuthorization(created.sessionId, now - 3_000, now), now - 1_000);
  const stored = await readSession(
    mockRequest({ headers: { cookie: cookieHeader(created.cookie) } }),
    now,
  );
  assert.equal(stored.session.lastAuthorizedAt, now - 1_000);
  await deleteSession(created.sessionId);
  assert.equal(await updateSessionAuthorization(created.sessionId, now, now), null);
  assert.equal(
    [...store.values.keys()].filter((key) => key.startsWith('session:v1:')).length,
    0,
  );
});

test('GAS failure does not extend authorization and day details always performs synchronous GAS authorization', async () => {
  const now = Date.now();
  const created = await createSession('employee@example.com', now - 5_000, {
    lastAuthorizedAt: now - 59_000,
  });
  const cookie = cookieHeader(created.cookie);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'upstream' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
  const failed = mockResponse();
  await calendarHandler(mockRequest({ headers: { cookie } }), failed);
  assert.equal(failed.statusCode, 503);
  let stored = await readSession(mockRequest({ headers: { cookie } }), now);
  assert.equal(stored.session.lastAuthorizedAt, now - 59_000);

  let detailCalls = 0;
  globalThis.fetch = async (_url, options) => {
    detailCalls += 1;
    assert.equal(JSON.parse(options.body).action, 'dayDetails');
    return gasResponse({
      ok: true,
      data: { date: '2026-09-28', items: [], revision: 'revision-a' },
    });
  };
  const details = mockResponse();
  await dayDetailsHandler(mockRequest({
    headers: { cookie },
    query: { date: '2026-09-28', revision: 'revision-a' },
  }), details);
  assert.equal(details.statusCode, 200);
  assert.equal(detailCalls, 1);
  assert.equal(details.json().authorization.revalidated, true);
});

test('bootstrap reads the session once and returns only anonymous identity plus calendar summary', async () => {
  const created = await createSession('employee@example.com', Date.now());
  let sessionReads = 0;
  const originalGet = store.get.bind(store);
  store.get = async (key) => {
    if (String(key).startsWith('session:v1:')) sessionReads += 1;
    return originalGet(key);
  };
  globalThis.fetch = async () => gasResponse({
    ok: true,
    data: { days: [], levels: [], updatedAt: '2026-09-25T00:00:00.000Z' },
  });

  const response = mockResponse();
  await bootstrapHandler(mockRequest({ headers: { cookie: cookieHeader(created.cookie) } }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(sessionReads, 1);
  assert.equal(response.json().authenticated, true);
  assert.match(response.json().userCacheKey, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(response.json().data.days, []);
  assert.equal(response.getHeader('cache-control'), 'private, no-store, max-age=0');
  assert.match(response.getHeader('server-timing'), /upstash;dur=/);
  assert.doesNotMatch(response.body, /employee@example\.com|session:v1:/);
});

test('detailed GAS timing is logged server-side and removed from browser responses', async () => {
  const created = await createSession('employee@example.com', Date.now());
  const originalInfo = console.info;
  const messages = [];
  console.info = (message) => messages.push(String(message));
  globalThis.fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return gasResponse({
      ok: true,
      data: {
        days: [],
        levels: [],
        updatedAt: '2026-09-25T00:00:00.000Z',
        serverTiming: {
          hmacVerificationMs: 9,
          employeePermissionCheckMs: 8,
          calendarAggregateReadMs: 1,
        },
        internalTiming: detailedGasTiming(),
      },
    });
  };

  try {
    const response = mockResponse();
    await calendarHandler(
      mockRequest({ headers: { cookie: cookieHeader(created.cookie) } }),
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.internalTiming, undefined);
    assert.doesNotMatch(response.body, /requestParseMs|gasAppTotalMs|employee@example\.com/);
    assert.doesNotMatch(response.getHeader('server-timing'), /requestParse|gasAppTotal/);
  } finally {
    console.info = originalInfo;
  }

  const timingLog = messages.map((message) => JSON.parse(message))
    .find((message) => message.event === 'gas_internal_timing');
  assert.ok(timingLog);
  assert.equal(timingLog.action, 'calendar');
  assert.equal(timingLog.hmacComputeMs, 1);
  assert.equal(timingLog.groupExpansionMs, 0);
  assert.ok(timingLog.gasTransportAndPlatformMs >= 0);
  assert.doesNotMatch(JSON.stringify(timingLog), /employee@example\.com|session:v1:/);
});

test('permission removal invalidates an existing server-side session on next check', async () => {
  const created = await createSession('employee@example.com', Date.now());
  globalThis.fetch = async () => gasResponse({ ok: true, data: { authorized: true } });
  const first = mockResponse();
  await sessionHandler(mockRequest({ headers: { cookie: cookieHeader(created.cookie) } }), first);
  assert.equal(first.statusCode, 200);

  globalThis.fetch = async () => gasResponse({ ok: false, error: 'ACCESS_DENIED' });
  const denied = mockResponse();
  await calendarHandler(mockRequest({ headers: { cookie: cookieHeader(created.cookie) } }), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, 'ACCESS_DENIED');
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
