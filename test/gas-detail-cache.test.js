import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'gas-internal-api', 'Code.js'), 'utf8');

function createContext() {
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
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'gas-internal-api/Code.js' });
  return context;
}

test('the one-minute aggregate refresh precomputes revision-scoped detail data', () => {
  const context = createContext();
  let cacheDetailsArgument = null;
  let aggregateWritten = false;
  context.openSpreadsheet_ = () => ({});
  context.readAccessPolicyHmacSecret_ = () => 'test-only-secret';
  context.buildSpreadsheetAccessPolicy_ = () => ({
    policy: {},
    stats: { allowedAccountCount: 1, domainPermissionCount: 0, groupPermissionCount: 0 },
  });
  context.cacheSpreadsheetAccessPolicy_ = () => {};
  context.buildFreshCalendarData_ = (_spreadsheet, _timing, cacheDetails) => {
    cacheDetailsArgument = cacheDetails;
    return {
      sheetId: 1,
      days: [{ date: '2026-09-29', count: 1, level: 1, symbol: '○' }],
      levels: [],
      updatedAt: '2026-09-29T00:00:00.000Z',
      detailRevision: 'revision-a',
    };
  };
  context.cacheCalendarAggregate_ = () => { aggregateWritten = true; };
  context.attachCalendarTiming_ = (result) => result;

  const response = context.refreshCalendarAggregateCache();
  assert.equal(response.ok, true);
  assert.equal(cacheDetailsArgument, true);
  assert.equal(aggregateWritten, true);
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
  context.cacheDayDetailsSnapshot_ = () => {};
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
