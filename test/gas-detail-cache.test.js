import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'gas-internal-api', 'Code.js'), 'utf8');

function createContext() {
  class MockCache {
    constructor() {
      this.values = new Map();
      this.ttls = [];
      this.failPut = false;
      this.failPutAll = false;
    }

    get(key) { return this.values.get(key) ?? null; }
    put(key, value, ttl) {
      if (this.failPut) throw new Error('cache put failed');
      this.values.set(key, String(value));
      this.ttls.push({ operation: 'put', key, ttl });
    }
    putAll(values, ttl) {
      if (this.failPutAll) throw new Error('cache putAll failed');
      Object.entries(values).forEach(([key, value]) => this.values.set(key, String(value)));
      this.ttls.push({ operation: 'putAll', ttl });
    }
  }

  const scriptCache = new MockCache();
  const userCache = new MockCache();
  const scriptProperties = new Map();
  const userProperties = new Map();
  const userLockState = { held: false, available: true, waits: [], releases: 0 };
  const scriptState = { id: 'production-script-id' };
  const context = {
    console: { info() {}, warn() {}, error() {} },
    Date,
    JSON,
    Math,
    Object,
    Array,
    Number,
    String,
    Set,
    Map,
    RegExp,
    Error,
    Infinity,
    CacheService: {
      getScriptCache: () => scriptCache,
      getUserCache: () => userCache,
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => scriptProperties.get(key) ?? null,
      }),
      getUserProperties: () => ({
        getProperty: (key) => userProperties.get(key) ?? null,
        setProperty: (key, value) => userProperties.set(key, String(value)),
      }),
    },
    LockService: {
      getUserLock: () => ({
        tryLock(milliseconds) {
          userLockState.waits.push(milliseconds);
          if (!userLockState.available || userLockState.held) return false;
          userLockState.held = true;
          return true;
        },
        releaseLock() {
          assert.equal(userLockState.held, true);
          userLockState.held = false;
          userLockState.releases += 1;
        },
      }),
    },
    ScriptApp: {
      getScriptId: () => scriptState.id,
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'gas-internal-api/Code.js' });
  context.testState = {
    scriptCache,
    userCache,
    scriptProperties,
    userProperties,
    userLockState,
    scriptState,
  };
  return context;
}

test('the one-minute aggregate refresh precomputes revision-scoped detail data', () => {
  const context = createContext();
  let published = false;
  context.openSpreadsheet_ = () => ({});
  context.readAccessPolicyHmacSecret_ = () => 'test-only-secret';
  context.buildSpreadsheetAccessPolicy_ = () => ({
    policy: {},
    stats: { allowedAccountCount: 1, domainPermissionCount: 0, groupPermissionCount: 0 },
  });
  context.cacheSpreadsheetAccessPolicy_ = () => {};
  context.buildFreshCalendarData_ = () => {
    return {
      calendar: {
        sheetId: 1,
        days: [{ date: '2026-09-29', count: 1, level: 1, symbol: '○' }],
        levels: [],
        updatedAt: '2026-09-29T00:00:00.000Z',
        detailRevision: 'revision-a',
      },
      detailsByDate: { '2026-09-29': [] },
    };
  };
  context.publishCalendarSnapshot_ = (_calendar, details, _startedAt, lockAlreadyHeld) => {
    assert.deepEqual(JSON.parse(JSON.stringify(details)), { '2026-09-29': [] });
    assert.equal(lockAlreadyHeld, true);
    published = true;
    return { published: true, reason: 'published' };
  };
  context.attachCalendarTiming_ = (result) => result;

  const response = context.refreshCalendarAggregateCache();
  assert.equal(response.ok, true);
  assert.equal(published, true);
  assert.equal(context.testState.userLockState.held, false);
});

test('day-details cache hit avoids Spreadsheet access and is reported as a safe numeric timing', () => {
  const context = createContext();
  context.getCachedDayDetails_ = () => ({
    date: '2026-09-29',
    items: [],
    updatedAt: '2026-09-29T00:00:00.000Z',
    revision: 'revision-a',
  });
  context.openSpreadsheet_ = () => { throw new Error('Spreadsheet must not be opened'); };
  const timing = context.createInternalRequestTiming_(Date.now());

  const result = context.getInternalApiDayDetails_('2026-09-29', 'revision-a', timing);
  assert.equal(result.revision, 'revision-a');
  assert.equal(timing.dayDetailsCacheHit, 1);
  assert.ok(timing.dayDetailsCacheReadMs >= 0);
  assert.equal(timing.dayDetailsSpreadsheetReadMs, 0);
});

test('day-details cache miss records exclusive Spreadsheet, build, revision, and cache-write timings', () => {
  const context = createContext();
  context.getCachedDayDetails_ = () => null;
  context.openSpreadsheet_ = (timing) => {
    timing.spreadsheetOpenMs = 3;
    return {};
  };
  context.resolveCurrentScheduleSheet_ = (timing) => {
    timing.latestSheetResolutionMs = 10;
    timing.spreadsheetReadMs = 5;
    return { sheetId: 1 };
  };
  context.readScheduleSnapshot_ = (_layout, timing) => {
    timing.spreadsheetReadMs += 3;
    timing.aggregationMs = 2;
    return {
      countsByDate: { '2026-09-29': 1 },
      detailsByDate: { '2026-09-29': [] },
      updatedAt: '2026-09-29T00:00:00.000Z',
    };
  };
  context.buildDetailRevision_ = () => 'revision-a';
  context.publishCalendarSnapshot_ = () => ({ published: true, reason: 'published' });
  const timing = context.createInternalRequestTiming_(Date.now());

  const result = context.getInternalApiDayDetails_('2026-09-29', 'revision-a', timing);
  assert.equal(result.revision, 'revision-a');
  assert.equal(timing.dayDetailsCacheHit, 0);
  assert.equal(timing.dayDetailsSpreadsheetOpenMs, 3);
  assert.equal(timing.dayDetailsSheetResolutionMs, 2);
  assert.equal(timing.dayDetailsSpreadsheetReadMs, 8);
  assert.equal(timing.dayDetailsBuildMs, 2);
  assert.ok(timing.dayDetailsRevisionMs >= 0);
  assert.ok(timing.dayDetailsCacheWriteMs >= 0);
});

function calendarFixture(revision, label) {
  return {
    sheetId: 101,
    days: [{ date: '2026-09-29', count: label === 'new' ? 2 : 1, level: 1, symbol: '○' }],
    levels: [
      { level: 0, symbol: '◎', label: '余裕あり' },
      { level: 1, symbol: '○', label: '対応可能' },
      { level: 2, symbol: '△', label: 'やや混雑' },
      { level: 3, symbol: '×', label: '混雑' },
    ],
    updatedAt: label === 'new' ? '2026-09-29T00:01:00.000Z' : '2026-09-29T00:00:00.000Z',
    detailRevision: revision,
  };
}

test('overlapping trigger skips immediately without opening Spreadsheet and releases no foreign lock', () => {
  const context = createContext();
  context.testState.userLockState.held = true;
  context.openSpreadsheet_ = () => { throw new Error('must not start overlapping work'); };

  const result = context.refreshCalendarAggregateCache();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true,
    data: { skipped: true, reason: 'overlap' },
  });
  assert.deepEqual(context.testState.userLockState.waits, [1]);
  assert.equal(context.testState.userLockState.releases, 0);
});

test('newer trigger publication prevents an older fallback from rolling generation backward', () => {
  const context = createContext();
  const oldRevision = 'A'.repeat(43);
  const newRevision = 'B'.repeat(43);
  const newer = context.publishCalendarSnapshot_(
    calendarFixture(newRevision, 'new'),
    { '2026-09-29': [{ customer: 'new', content: '', work: '印刷', period: 'AM' }] },
    200,
    false,
  );
  const olderFallback = context.publishCalendarSnapshot_(
    calendarFixture(oldRevision, 'old'),
    { '2026-09-29': [{ customer: 'old', content: '', work: '印刷', period: 'AM' }] },
    100,
    false,
  );

  assert.equal(newer.published, true);
  assert.deepEqual(JSON.parse(JSON.stringify(olderFallback)), {
    published: false,
    reason: 'stale_generation',
  });
  const active = JSON.parse(context.testState.userCache.values.get('day-details:active:v1'));
  const aggregate = JSON.parse(context.testState.scriptCache.values.get('calendar-aggregate:v1'));
  assert.equal(active.revision, newRevision);
  assert.equal(active.startedAtMs, 200);
  assert.equal(aggregate.detailRevision, newRevision);
});

test('web fallback never waits behind a running trigger and does not publish a partial generation', () => {
  const context = createContext();
  context.testState.userLockState.held = true;
  const result = context.publishCalendarSnapshot_(
    calendarFixture('C'.repeat(43), 'new'),
    { '2026-09-29': [] },
    300,
    false,
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    published: false,
    reason: 'publish_lock_unavailable',
  });
  assert.deepEqual(context.testState.userLockState.waits, [1]);
  assert.equal(context.testState.userCache.values.size, 0);
  assert.equal(context.testState.scriptCache.values.size, 0);
});

test('partial detail-cache failure leaves aggregate unpublished and reserves order against stale retries', () => {
  const context = createContext();
  const revision = 'D'.repeat(43);
  context.testState.userCache.failPutAll = true;
  const failed = context.publishCalendarSnapshot_(
    calendarFixture(revision, 'new'),
    { '2026-09-29': [] },
    400,
    false,
  );
  context.testState.userCache.failPutAll = false;
  const staleRetry = context.publishCalendarSnapshot_(
    calendarFixture('E'.repeat(43), 'old'),
    { '2026-09-29': [] },
    399,
    false,
  );

  assert.equal(failed.reason, 'detail_cache_write_failed');
  assert.equal(context.testState.scriptCache.values.has('calendar-aggregate:v1'), false);
  assert.equal(staleRetry.reason, 'stale_generation');
  assert.equal(context.testState.userLockState.held, false);
  assert.equal(context.testState.userLockState.releases, 2);
});

test('successful publication uses 75-second detail TTL and lock recovers after a trigger exception', () => {
  const context = createContext();
  context.openSpreadsheet_ = () => { throw new Error('simulated failure'); };
  const failedTrigger = context.refreshCalendarAggregateCache();
  assert.equal(failedTrigger.ok, false);
  assert.equal(context.testState.userLockState.held, false);

  const revision = 'F'.repeat(43);
  const recovered = context.publishCalendarSnapshot_(
    calendarFixture(revision, 'new'),
    { '2026-09-29': [] },
    500,
    false,
  );
  assert.equal(recovered.published, true);
  assert.ok(context.testState.userCache.ttls.length >= 2);
  assert.ok(context.testState.userCache.ttls.every((entry) => entry.ttl === 75));
  assert.equal(context.testState.userLockState.held, false);
});

test('staging Script ID fails closed until its isolated data source marker is configured', () => {
  const context = createContext();
  const stagingScriptId = '1cQSSPk0RJzPC4oI9Yl3SZFLqOnxAm-XNmdVFD9y8flhIoZW7VDBmSWQG';
  context.testState.scriptState.id = stagingScriptId;
  assert.throws(
    () => context.getCalendarSpreadsheetId_(),
    /staging calendar data source is not initialized/,
  );

  context.testState.scriptProperties.set(
    'CALENDAR_SPREADSHEET_ID',
    'staging-spreadsheet-id-12345',
  );
  assert.throws(
    () => context.getCalendarSpreadsheetId_(),
    /staging calendar data source is not initialized/,
  );

  context.testState.scriptProperties.set(
    'STAGING_ENVIRONMENT',
    'danpro-calendar-internal-staging',
  );
  assert.equal(context.getCalendarSpreadsheetId_(), 'staging-spreadsheet-id-12345');
});
