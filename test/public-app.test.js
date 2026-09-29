import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const USER_A = 'A'.repeat(43);
const USER_B = 'B'.repeat(43);
const FIXED_NOW = '2026-09-28T12:00:00.000Z';

class MockElement {
  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.hidden = false;
    this.textContent = '';
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
    };
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    this.offsetWidth = 280;
    this.offsetHeight = 120;
  }

  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'href') delete this.href; }
  addEventListener(name, listener) { this.listeners[name] ||= []; this.listeners[name].push(listener); }
  focus() {}
  getBoundingClientRect() {
    return { left: 20, right: 100, top: 20, bottom: 100, width: 80, height: 80 };
  }
}

function calendarData(count = 1) {
  const level = count <= 2 ? 1 : count <= 4 ? 2 : 3;
  return {
    days: [{ date: '2026-09-28', count, level, symbol: ['◎', '○', '△', '×'][level] }],
    levels: [
      { level: 0, symbol: '◎', label: '余裕あり' },
      { level: 1, symbol: '○', label: '対応可能' },
      { level: 2, symbol: '△', label: 'やや混雑' },
      { level: 3, symbol: '×', label: '混雑' },
    ],
    updatedAt: '2026-09-28T11:59:00.000Z',
    detailRevision: 'revision-a',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/test-id/edit?gid=1',
  };
}

function cachedSummary(data = calendarData()) {
  return {
    version: 1,
    savedAt: Date.parse(FIXED_NOW) - 1_000,
    days: data.days.map(({ date, count, level, symbol }) => ({ date, count, level, symbol })),
    levels: data.levels.map(({ level, symbol, label }) => ({ level, symbol, label })),
    updatedAt: data.updatedAt,
  };
}

function authorizedBootstrap(data = calendarData()) {
  return {
    ok: true,
    authenticated: true,
    userCacheKey: USER_A,
    data,
    authorization: { revalidated: true, validForMs: 58_000 },
  };
}

function twoDayCalendarData(revision = 'revision-a') {
  const data = calendarData();
  data.detailRevision = revision;
  data.days.push({ date: '2026-09-29', count: 3, level: 2, symbol: '△' });
  return data;
}

function jsonResponse(payload, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Server-Timing': 'upstash;dur=4.0, total;dur=8.0',
    },
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

function makeScenario(options = {}) {
  const ids = [
    'login-panel', 'login-error', 'calendar-panel', 'logout', 'calendar-wrap',
    'calendar-grid', 'month-title', 'status-text', 'spinner', 'refresh-status',
    'error', 'legend', 'previous-month', 'next-month', 'today', 'source-link',
    'hover-preview', 'detail-backdrop', 'detail-modal', 'detail-title',
    'detail-body', 'detail-close',
  ];
  const elements = new Map(ids.map((id) => [id, new MockElement(id)]));
  elements.get('calendar-panel').hidden = true;
  elements.get('login-error').hidden = true;
  elements.get('source-link').hidden = true;
  elements.get('hover-preview').hidden = true;
  elements.get('detail-backdrop').hidden = true;
  elements.get('error').hidden = true;
  elements.get('refresh-status').hidden = true;

  const storage = new Map();
  if (options.cacheUserKey) {
    storage.set('danpro-employee-calendar-active:v2', options.cacheUserKey);
    storage.set(
      `danpro-employee-calendar:v2:${options.cacheUserKey}`,
      JSON.stringify(options.cachedSummary || cachedSummary()),
    );
  }

  const pending = { session: [], calendar: [], details: [] };
  const calls = { session: 0, bootstrap: 0, calendar: 0, details: 0 };
  const timers = [];
  const intervals = [];
  let performanceNow = 0;
  const documentListeners = {};
  const windowListeners = {};
  const documentElement = new MockElement('html', 'html');

  const responseFor = (route, fallback) => {
    const queue = options[`${route}Responses`];
    const entry = Array.isArray(queue) && queue.length ? queue.shift() : fallback;
    if (entry && entry.deferred) {
      const item = deferred();
      pending[route].push(item);
      return item.promise;
    }
    if (entry instanceof Response) return Promise.resolve(entry);
    return Promise.resolve(jsonResponse(entry));
  };

  const fetch = async (url) => {
    const target = String(url);
    if (target === '/api/auth/session') {
      calls.session += 1;
      return responseFor('session', options.sessionResponse);
    }
    if (target === '/api/bootstrap') {
      calls.bootstrap += 1;
      return responseFor('bootstrap', options.bootstrapResponse);
    }
    if (target === '/api/calendar') {
      calls.calendar += 1;
      return responseFor('calendar', options.calendarResponse);
    }
    if (target.startsWith('/api/day-details')) {
      calls.details += 1;
      return responseFor('details', options.detailsResponse);
    }
    if (target === '/api/auth/logout') return jsonResponse({}, 204);
    throw new Error(`unexpected fetch ${target}`);
  };

  const document = {
    body: new MockElement('body', 'body'),
    documentElement,
    visibilityState: 'visible',
    getElementById: (id) => elements.get(id),
    createElement: (tag) => new MockElement('', tag),
    addEventListener(name, listener) { documentListeners[name] ||= []; documentListeners[name].push(listener); },
    contains: () => true,
  };
  const window = {
    innerWidth: 1280,
    innerHeight: 900,
    performance: { now: () => performanceNow },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    matchMedia: () => ({ matches: true }),
    addEventListener(name, listener) { windowListeners[name] ||= []; windowListeners[name].push(listener); },
    setInterval(callback, milliseconds) {
      intervals.push({ callback, milliseconds, cancelled: false });
      return intervals.length;
    },
    clearInterval(id) { if (intervals[id - 1]) intervals[id - 1].cancelled = true; },
    setTimeout(callback, milliseconds) {
      timers.push({ callback, milliseconds, cancelled: false });
      return timers.length;
    },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cancelled = true; },
  };
  class MockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [FIXED_NOW])); }
    static now() { return Date.parse(FIXED_NOW); }
  }
  const context = {
    window,
    document,
    fetch,
    Response,
    URL,
    Intl,
    Date: MockDate,
    Object,
    Number,
    String,
    Array,
    Math,
    Map,
    Set,
    Promise,
    encodeURIComponent,
    console: { info() {}, warn() {}, error() {} },
  };
  vm.createContext(context);
  vm.runInContext(appSource, context, { filename: 'public/app.js' });

  return {
    calls,
    elements,
    intervals,
    pending,
    storage,
    timers,
    window,
    advance(milliseconds) { performanceNow += milliseconds; },
    async runInterval(index = 0) {
      intervals[index].callback();
      await flush();
    },
    async runAuthorizationExpiry() {
      const timer = timers.findLast((item) => !item.cancelled && item.milliseconds > 1_000);
      assert.ok(timer, 'authorization expiry timer should exist');
      performanceNow += timer.milliseconds + 1;
      timer.callback();
      await flush();
    },
  };
}

function dayCell(scenario) {
  return scenario.elements.get('calendar-grid').children
    .find((element) => element.children.some((child) => ['○', '△', '×'].includes(child.textContent)));
}

async function click(element) {
  for (const listener of element.listeners.click || []) await listener({ target: element });
  await flush();
}

test('59-second grace renders only cached summary before GAS and unlocks details after refresh', async () => {
  const scenario = makeScenario({
    cacheUserKey: USER_A,
    sessionResponse: {
      authenticated: true,
      userCacheKey: USER_A,
      authorization: { revalidated: false, validForMs: 59_000 },
    },
    calendarResponses: [{ deferred: true }],
    detailsResponse: {
      ok: true,
      data: { date: '2026-09-28', items: [], revision: 'revision-a' },
      authorization: { revalidated: true, validForMs: 58_000 },
    },
  });
  await flush();
  let cell = dayCell(scenario);
  assert.ok(cell, 'cached summary should render');
  assert.equal(cell.tagName, 'DIV');
  assert.equal((cell.listeners.click || []).length, 0);
  assert.equal(scenario.elements.get('spinner').hidden, true);
  assert.equal(scenario.elements.get('source-link').hidden, true);
  assert.equal(scenario.calls.calendar, 1);
  assert.equal(scenario.calls.details, 0);

  scenario.pending.calendar[0].resolve(jsonResponse({
    ok: true,
    data: calendarData(3),
    authorization: { revalidated: true, validForMs: 58_000 },
  }));
  await flush();
  cell = dayCell(scenario);
  assert.equal(cell.tagName, 'BUTTON');
  await click(cell);
  assert.equal(scenario.calls.details, 1);
});

test('expired grace does not display cached summary until synchronous authorization completes', async () => {
  const scenario = makeScenario({
    cacheUserKey: USER_A,
    sessionResponses: [{ deferred: true }],
    calendarResponses: [{ deferred: true }],
  });
  await flush();
  assert.equal(dayCell(scenario), undefined);
  scenario.pending.session[0].resolve(jsonResponse({
    authenticated: true,
    userCacheKey: USER_A,
    authorization: { revalidated: true, validForMs: 58_000 },
  }));
  await flush();
  assert.ok(dayCell(scenario));
});

test('403 during grace clears browser summary and hides the calendar', async () => {
  const scenario = makeScenario({
    cacheUserKey: USER_A,
    sessionResponse: {
      authenticated: true,
      userCacheKey: USER_A,
      authorization: { revalidated: false, validForMs: 59_000 },
    },
    calendarResponses: [{ deferred: true }],
  });
  await flush();
  scenario.pending.calendar[0].resolve(jsonResponse({ error: { code: 'ACCESS_DENIED' } }, 403));
  await flush();
  assert.equal(scenario.elements.get('calendar-panel').hidden, true);
  assert.equal(scenario.storage.has(`danpro-employee-calendar:v2:${USER_A}`), false);
  assert.equal(dayCell(scenario), undefined);
});

test('GAS failure preserves summary only within grace and then fails closed', async () => {
  const scenario = makeScenario({
    cacheUserKey: USER_A,
    sessionResponse: {
      authenticated: true,
      userCacheKey: USER_A,
      authorization: { revalidated: false, validForMs: 59_000 },
    },
    calendarResponses: [{ deferred: true }],
  });
  await flush();
  scenario.pending.calendar[0].resolve(jsonResponse({ error: 'DATA_UNAVAILABLE' }, 503));
  await flush();
  assert.ok(dayCell(scenario));
  assert.equal(dayCell(scenario).tagName, 'DIV');
  assert.equal(scenario.storage.has(`danpro-employee-calendar:v2:${USER_A}`), true);
  await scenario.runAuthorizationExpiry();
  assert.equal(dayCell(scenario), undefined);
  assert.match(scenario.elements.get('status-text').textContent, /権限/);
});

test('an older successful refresh cannot override a newer authorization failure', async () => {
  const scenario = makeScenario({
    cacheUserKey: USER_A,
    sessionResponse: {
      authenticated: true,
      userCacheKey: USER_A,
      authorization: { revalidated: false, validForMs: 59_000 },
    },
    calendarResponses: [
      { deferred: true },
      { deferred: true },
    ],
    detailsResponses: [{ deferred: true }],
  });
  await flush();
  scenario.pending.calendar[0].resolve(jsonResponse({
    ok: true,
    data: calendarData(),
    authorization: { revalidated: true, validForMs: 58_000 },
  }));
  await flush();
  await scenario.runInterval(0);
  const authorizedCell = dayCell(scenario);
  const detailPromise = click(authorizedCell);
  scenario.pending.details[0].resolve(jsonResponse({ error: 'DATA_UNAVAILABLE' }, 503));
  await detailPromise;
  scenario.pending.calendar[1].resolve(jsonResponse({
    ok: true,
    data: calendarData(3),
    authorization: { revalidated: true, validForMs: 58_000 },
  }));
  await flush();
  assert.equal(dayCell(scenario).tagName, 'DIV');
});

test('a different employee cache key is never rendered', async () => {
  const scenario = makeScenario({
    cacheUserKey: USER_A,
    sessionResponse: {
      authenticated: true,
      userCacheKey: USER_B,
      authorization: { revalidated: false, validForMs: 59_000 },
    },
    calendarResponses: [{ deferred: true }],
  });
  await flush();
  assert.equal(dayCell(scenario), undefined);
  assert.equal(scenario.calls.calendar, 1);
});

test('hover starts one request immediately, click shares it, and cached hover uses the shorter UI delay', async () => {
  const scenario = makeScenario({
    bootstrapResponse: authorizedBootstrap(),
    detailsResponses: [{ deferred: true }],
  });
  await flush();
  let cell = dayCell(scenario);
  cell.listeners.pointerenter[0]();
  assert.equal(scenario.calls.details, 1);
  const firstHoverTimer = scenario.timers.findLast((timer) => timer.milliseconds === 250);
  assert.ok(firstHoverTimer);
  const firstHoverRender = firstHoverTimer.callback();
  const clickPromise = click(cell);
  assert.equal(scenario.calls.details, 1, 'hover and click must share the pending request');
  scenario.pending.details[0].resolve(jsonResponse({
    ok: true,
    data: { date: '2026-09-28', items: [], revision: 'revision-a' },
    authorization: { revalidated: true, validForMs: 58_000 },
  }));
  await Promise.all([firstHoverRender, clickPromise]);
  assert.equal(scenario.elements.get('detail-body').children[0].className, 'detail-empty');

  scenario.elements.get('detail-close').listeners.click[0]();
  cell = dayCell(scenario);
  cell.listeners.pointerenter[0]();
  const cachedHoverTimer = scenario.timers.findLast((timer) => timer.milliseconds === 80);
  assert.ok(cachedHoverTimer, 'memory hit should retain an intentional but shorter hover delay');
  await cachedHoverTimer.callback();
  assert.equal(scenario.calls.details, 1, 'memory hit must not create another API request');
});

test('rapid date movement cannot revive an old hover response or show the wrong date', async () => {
  const scenario = makeScenario({
    bootstrapResponse: authorizedBootstrap(twoDayCalendarData()),
    detailsResponses: [{ deferred: true }, { deferred: true }],
  });
  await flush();
  const cells = scenario.elements.get('calendar-grid').children.filter((element) => element.dataset.date);
  const first = cells.find((cell) => cell.dataset.date === '2026-09-28');
  const second = cells.find((cell) => cell.dataset.date === '2026-09-29');
  first.listeners.pointerenter[0]();
  const firstTimer = scenario.timers.findLast((timer) => timer.milliseconds === 250);
  first.listeners.pointerleave[0]();
  second.listeners.pointerenter[0]();
  const secondTimer = scenario.timers.findLast((timer) => timer.milliseconds === 250 && timer !== firstTimer);
  assert.equal(scenario.calls.details, 2);

  const secondRender = secondTimer.callback();
  scenario.pending.details[1].resolve(jsonResponse({
    ok: true,
    data: { date: '2026-09-29', items: [], revision: 'revision-a' },
    authorization: { revalidated: true, validForMs: 58_000 },
  }));
  await secondRender;
  assert.equal(scenario.elements.get('hover-preview').children[0].textContent, '9月29日（火）');

  const staleRender = firstTimer.callback();
  scenario.pending.details[0].resolve(jsonResponse({
    ok: true,
    data: { date: '2026-09-28', items: [], revision: 'revision-a' },
    authorization: { revalidated: true, validForMs: 58_000 },
  }));
  await staleRender;
  assert.equal(scenario.elements.get('hover-preview').children[0].textContent, '9月29日（火）');
});

test('403 on a newer detail request prevents an older success from reviving cache or modal', async () => {
  const scenario = makeScenario({
    bootstrapResponse: authorizedBootstrap(twoDayCalendarData()),
    detailsResponses: [{ deferred: true }, { deferred: true }],
  });
  await flush();
  const cells = scenario.elements.get('calendar-grid').children.filter((element) => element.dataset.date);
  const firstPromise = click(cells.find((cell) => cell.dataset.date === '2026-09-28'));
  const secondPromise = click(cells.find((cell) => cell.dataset.date === '2026-09-29'));
  scenario.pending.details[1].resolve(jsonResponse({ error: { code: 'ACCESS_DENIED' } }, 403));
  await secondPromise;
  assert.equal(scenario.elements.get('detail-backdrop').hidden, true);
  scenario.pending.details[0].resolve(jsonResponse({
    ok: true,
    data: { date: '2026-09-28', items: [], revision: 'revision-a' },
    authorization: { revalidated: true, validForMs: 58_000 },
  }));
  await firstPromise;
  assert.equal(scenario.elements.get('detail-backdrop').hidden, true);
  assert.equal(dayCell(scenario), undefined);
});

test('logout prevents an in-flight detail success from reviving employee UI state', async () => {
  const scenario = makeScenario({
    bootstrapResponse: authorizedBootstrap(),
    detailsResponses: [{ deferred: true }],
  });
  await flush();
  const detailPromise = click(dayCell(scenario));
  await click(scenario.elements.get('logout'));
  assert.equal(scenario.elements.get('calendar-panel').hidden, true);
  scenario.pending.details[0].resolve(jsonResponse({
    ok: true,
    data: { date: '2026-09-28', items: [], revision: 'revision-a' },
    authorization: { revalidated: true, validForMs: 58_000 },
  }));
  await detailPromise;
  assert.equal(scenario.elements.get('detail-backdrop').hidden, true);
  assert.equal(dayCell(scenario), undefined);
});

test('unchanged refresh retains memory details while a detail revision change invalidates them', async () => {
  const unchanged = calendarData();
  const changed = calendarData();
  changed.detailRevision = 'revision-b';
  const scenario = makeScenario({
    bootstrapResponse: authorizedBootstrap(unchanged),
    calendarResponses: [
      { ok: true, data: unchanged, authorization: { revalidated: true, validForMs: 58_000 } },
      { ok: true, data: changed, authorization: { revalidated: true, validForMs: 58_000 } },
    ],
    detailsResponses: [
      {
        ok: true,
        data: { date: '2026-09-28', items: [], revision: 'revision-a' },
        authorization: { revalidated: true, validForMs: 58_000 },
      },
      {
        ok: true,
        data: { date: '2026-09-28', items: [], revision: 'revision-b' },
        authorization: { revalidated: true, validForMs: 58_000 },
      },
    ],
  });
  await flush();
  await click(dayCell(scenario));
  assert.equal(scenario.calls.details, 1);
  scenario.elements.get('detail-close').listeners.click[0]();
  await scenario.runInterval(0);
  await click(dayCell(scenario));
  assert.equal(scenario.calls.details, 1, 'unchanged detail revision should retain memory details');
  scenario.elements.get('detail-close').listeners.click[0]();
  await scenario.runInterval(0);
  await click(dayCell(scenario));
  assert.equal(scenario.calls.details, 2, 'changed detail revision must invalidate memory details');
});
