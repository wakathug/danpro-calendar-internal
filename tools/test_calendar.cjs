'use strict';

process.env.TZ = 'Asia/Tokyo';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'コード.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
const browserScript = htmlSource.match(/<script>([\s\S]*?)<\/script>/)[1];

function blankSheet(rows, columns) {
  return Array.from({ length: rows }, () => Array(columns).fill(''));
}

function displayValue(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

const spreadsheetMetrics = {
  openById: 0,
  getRange: 0,
  getValues: 0,
  getDisplayValues: 0,
  getMergedRanges: 0,
  getDisplayValue: 0,
};

function resetSpreadsheetMetrics() {
  Object.keys(spreadsheetMetrics).forEach((key) => {
    spreadsheetMetrics[key] = 0;
  });
}

function copySpreadsheetMetrics() {
  return { ...spreadsheetMetrics };
}

class MockRange {
  constructor(sheet, row, column, rowCount, columnCount) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  readValues() {
    const values = [];
    for (let rowOffset = 0; rowOffset < this.rowCount; rowOffset += 1) {
      const sourceRow = this.sheet.values[this.row - 1 + rowOffset] || [];
      const resultRow = [];
      for (let columnOffset = 0; columnOffset < this.columnCount; columnOffset += 1) {
        resultRow.push(sourceRow[this.column - 1 + columnOffset] ?? '');
      }
      values.push(resultRow);
    }
    return values;
  }

  getValues() {
    spreadsheetMetrics.getValues += 1;
    return this.readValues().map((row) => row.slice());
  }

  getDisplayValues() {
    spreadsheetMetrics.getDisplayValues += 1;
    return this.readValues().map((row) => row.map(displayValue));
  }

  getDisplayValue() {
    spreadsheetMetrics.getDisplayValue += 1;
    return displayValue(this.readValues()[0][0]);
  }

  getRow() {
    return this.row;
  }

  getColumn() {
    return this.column;
  }

  getLastRow() {
    return this.row + this.rowCount - 1;
  }

  getLastColumn() {
    return this.column + this.columnCount - 1;
  }

  getMergedRanges() {
    spreadsheetMetrics.getMergedRanges += 1;
    return this.sheet.mergedRanges
      .filter((merged) => (
        merged.row <= this.getLastRow()
        && merged.row + merged.rowCount - 1 >= this.row
        && merged.column <= this.getLastColumn()
        && merged.column + merged.columnCount - 1 >= this.column
      ))
      .map((merged) => new MockRange(
        this.sheet,
        merged.row,
        merged.column,
        merged.rowCount,
        merged.columnCount,
      ));
  }
}

class MockSheet {
  constructor(id, values, options = {}) {
    this.id = id;
    this.values = values;
    this.name = options.name || `sheet-${id}`;
    this.hidden = Boolean(options.hidden);
    this.mergedRanges = options.mergedRanges || [];
  }

  getSheetId() {
    return this.id;
  }

  getName() {
    return this.name;
  }

  isSheetHidden() {
    return this.hidden;
  }

  getLastRow() {
    return this.values.length;
  }

  getLastColumn() {
    return Math.max(...this.values.map((row) => row.length));
  }

  getRange(row, column, rowCount, columnCount) {
    spreadsheetMetrics.getRange += 1;
    return new MockRange(this, row, column, rowCount, columnCount);
  }
}

class MockCache {
  constructor() {
    this.values = new Map();
    this.metrics = { get: 0, put: 0, putAll: 0 };
  }

  get(key) {
    this.metrics.get += 1;
    return this.values.has(key) ? this.values.get(key) : null;
  }

  put(key, value) {
    this.metrics.put += 1;
    this.values.set(key, String(value));
  }

  putAll(values) {
    this.metrics.putAll += 1;
    Object.entries(values).forEach(([key, value]) => this.values.set(key, String(value)));
  }

  clear() {
    this.values.clear();
    this.metrics = { get: 0, put: 0, putAll: 0 };
  }
}

class MockElement {
  constructor(id = '', tagName = '') {
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
    this.style = {
      setProperty: (name, value) => { this.style[name] = value; },
    };
    this.offsetWidth = 280;
    this.offsetHeight = 120;
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'href') delete this.href;
  }

  addEventListener(name, listener) {
    this.listeners[name] ||= [];
    this.listeners[name].push(listener);
  }

  focus() {}

  getBoundingClientRect() {
    return { left: 20, right: 100, top: 20, bottom: 100, width: 80, height: 80 };
  }
}

function makeCalendarPayload(days = [{ date: '2026-09-08', count: 1, level: 1, symbol: '○' }]) {
  return {
    ok: true,
    data: {
      days,
      levels: [
        { level: 0, symbol: '◎', label: '余裕あり' },
        { level: 1, symbol: '○', label: '対応可能' },
        { level: 2, symbol: '△', label: 'やや混雑' },
        { level: 3, symbol: '×', label: '混雑' },
      ],
      updatedAt: '2026-09-08T07:00:00.000Z',
      timeZone: 'Asia/Tokyo',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/safe-test-id/edit?gid=1730965450',
    },
  };
}

function makeCalendarDay(date, count) {
  const level = count === 0 ? 0 : count <= 2 ? 1 : count <= 4 ? 2 : 3;
  return { date, count, level, symbol: ['◎', '○', '△', '×'][level] };
}

function runClientScenario(options) {
  const ids = [
    'calendar-wrap', 'calendar-grid', 'month-title', 'status-text', 'spinner', 'error',
    'legend', 'previous-month', 'next-month', 'today', 'source-link', 'hover-preview',
    'detail-backdrop', 'detail-modal', 'detail-title', 'detail-body', 'detail-close',
  ];
  const elements = new Map(ids.map((id) => [id, new MockElement(id)]));
  elements.get('source-link').hidden = true;
  elements.get('error').hidden = true;
  elements.get('hover-preview').hidden = true;
  elements.get('detail-backdrop').hidden = true;

  const documentListeners = {};
  const windowListeners = {};
  const intervals = [];
  const calls = { calendar: 0, details: [] };
  const document = {
    body: new MockElement('body'),
    visibilityState: 'visible',
    getElementById: (id) => elements.get(id),
    createElement: (tagName) => new MockElement('', tagName),
    addEventListener(name, listener) {
      documentListeners[name] ||= [];
      documentListeners[name].push(listener);
    },
    contains: () => true,
  };

  const window = {
    innerWidth: 1280,
    innerHeight: 900,
    matchMedia: () => ({ matches: Boolean(options.hoverCapable) }),
    addEventListener(name, listener) {
      windowListeners[name] ||= [];
      windowListeners[name].push(listener);
    },
    setInterval: (callback, milliseconds) => {
      intervals.push({ callback, milliseconds });
      return intervals.length;
    },
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout() {},
  };

  class Runner {
    withSuccessHandler(handler) { this.success = handler; return this; }
    withFailureHandler(handler) { this.failure = handler; return this; }
    getCalendarData() {
      calls.calendar += 1;
      if (options.calendarFailure) this.failure(new Error(options.calendarFailure));
      else this.success(options.calendarResponse);
    }
    getDayDetails(dateKey) {
      calls.details.push(dateKey);
      if (options.detailFailure) this.failure(new Error(options.detailFailure));
      else this.success(options.detailResponse);
    }
  }

  const google = { script: {} };
  Object.defineProperty(google.script, 'run', { get: () => new Runner() });
  const NativeDate = Date;
  const fixedNow = options.now || '2026-09-10T03:00:00.000Z';
  class MockDate extends NativeDate {
    constructor(...args) {
      super(...(args.length === 0 ? [fixedNow] : args));
    }

    static now() {
      return new NativeDate(fixedNow).getTime();
    }
  }
  const clientContext = {
    console,
    Date: MockDate,
    Intl,
    URL,
    Object,
    Number,
    String,
    Array,
    Math,
    Map,
    Promise,
    document,
    window,
    google,
  };
  vm.createContext(clientContext);
  vm.runInContext(browserScript, clientContext, { filename: 'Index.html<script>' });
  return { calls, document, documentListeners, elements, intervals, windowListeners };
}

function makeFixture() {
  const values = blankSheet(9, 17);
  Object.assign(values[1], {
    1: '受付',
    2: '依頼',
    3: '期限',
    4: '客先名',
    5: '担当',
    6: '作業者',
    7: '内容',
    9: '状況',
    10: 'ロット',
    11: '納品\n方法',
    12: '日時',
    13: '2025/12/31',
    14: '1/1',
    15: '1/2',
    16: '2026/1/2',
  });

  Object.assign(values[2], {
    0: '－', 4: '顧客A', 7: 'ギフト箱', 12: 'AM', 13: 'CAD', 16: '印刷',
  });
  Object.assign(values[3], {
    12: 'PM', 13: '印刷', 14: 'デザイン', 15: '   ',
  });
  Object.assign(values[4], {
    0: '－', 7: '内容のみ', 12: 'AM', 14: 'サンプル', 15: 'KCP',
  });
  Object.assign(values[5], {
    4: '客先のみ', 12: 'ＰＭ', 15: '納品',
  });

  // この行と以降は集計・詳細の対象外でなければならない。
  Object.assign(values[6], {
    0: '案件数', 4: '除外顧客', 7: '除外内容', 12: 'AM',
    13: '除外', 14: '除外', 15: '除外', 16: '除外',
  });
  Object.assign(values[7], {
    4: 'さらに除外', 12: 'PM', 14: '除外',
  });
  return values;
}

function makeScheduleSheet(id, name, options = {}) {
  const values = makeFixture().map((row) => row.slice());
  if (options.firstHeader) values[1][13] = options.firstHeader;
  if (options.customer) values[2][4] = options.customer;
  if (options.work) values[2][13] = options.work;
  return new MockSheet(id, values, {
    name,
    hidden: options.hidden,
    mergedRanges: [
      { row: 3, column: 5, rowCount: 2, columnCount: 1 },
      { row: 3, column: 8, rowCount: 2, columnCount: 1 },
      { row: 5, column: 8, rowCount: 2, columnCount: 1 },
    ],
  });
}

function makeMergedDetailsSheet() {
  const values = blankSheet(16, 14);
  values[1][13] = '2026/9/10';

  Object.assign(values[4], {
    4: '別案件', 7: '別内容', 12: 'AM',
  });
  Object.assign(values[5], {
    12: 'PM', 13: '納品',
  });

  Object.assign(values[9], {
    0: '－', 4: '高井屋', 7: 'DINOサブレ箱', 12: 'AM',
  });
  Object.assign(values[10], {
    12: 'PM', 13: '印刷',
  });
  Object.assign(values[11], {
    12: 'AM', 13: 'デザイン',
  });
  Object.assign(values[12], {
    12: 'PM', 13: '出荷',
  });
  values[13][0] = '案件数';

  return new MockSheet(6006, values, {
    name: '結合セル詳細',
    mergedRanges: [
      { row: 5, column: 12, rowCount: 2, columnCount: 1 },
      { row: 10, column: 12, rowCount: 4, columnCount: 1 },
      { row: 10, column: 5, rowCount: 4, columnCount: 1 },
      { row: 10, column: 8, rowCount: 4, columnCount: 1 },
    ],
  });
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const targetSheet = makeScheduleSheet(1730965450, '97');
const descriptionSheet = new MockSheet(999, blankSheet(6, 16), { name: '説明' });
let spreadsheetSheets = [descriptionSheet, targetSheet];
let openedSpreadsheetId = '';
let spreadsheetError = null;
const userCache = new MockCache();
const context = {
  console,
  Date,
  Object,
  Number,
  String,
  Array,
  Math,
  RegExp,
  JSON,
  SpreadsheetApp: {
    openById(id) {
      spreadsheetMetrics.openById += 1;
      openedSpreadsheetId = id;
      if (spreadsheetError) throw spreadsheetError;
      return {
        getSheets() {
          return spreadsheetSheets;
        },
      };
    },
  },
  CacheService: {
    getUserCache() {
      return userCache;
    },
  },
  Utilities: {
    formatDate,
  },
};
vm.createContext(context);
vm.runInContext(serverSource, context, { filename: 'コード.js' });

userCache.clear();
resetSpreadsheetMetrics();
const calendarResponse = context.getCalendarData();
assert.equal(calendarResponse.ok, true);
const calendar = calendarResponse.data;
assert.equal(openedSpreadsheetId, '1KOHReFlDdmJvLWX16Qram6TSogWMXwW4ddWRI6uWjfY');
assert.deepEqual(
  Array.from(calendar.days, (day) => ({
    date: day.date,
    count: day.count,
    level: day.level,
    symbol: day.symbol,
  })),
  [
    { date: '2025-12-31', count: 2, level: 1, symbol: '○' },
    { date: '2026-01-01', count: 0, level: 0, symbol: '◎' },
    { date: '2026-01-02', count: 1, level: 1, symbol: '○' },
  ],
);
assert.deepEqual(Object.keys(calendar.days[0]).sort(), ['count', 'date', 'level', 'symbol']);
assert.doesNotMatch(JSON.stringify(calendar), /customer|content|period|work|sheetId|generation/);
assert.equal(
  calendar.spreadsheetUrl,
  'https://docs.google.com/spreadsheets/d/1KOHReFlDdmJvLWX16Qram6TSogWMXwW4ddWRI6uWjfY/edit?gid=1730965450',
);
assert.deepEqual(copySpreadsheetMetrics(), {
  openById: 1,
  getRange: 5,
  getValues: 1,
  getDisplayValues: 3,
  getMergedRanges: 1,
  getDisplayValue: 0,
});

const metricsBeforeWarmHit = copySpreadsheetMetrics();
const warmCacheHit = context.getDayDetails('2026-01-01');
assert.equal(warmCacheHit.ok, true);
assert.equal(warmCacheHit.data.items.length, 2);
assert.deepEqual(copySpreadsheetMetrics(), metricsBeforeWarmHit);

userCache.clear();
resetSpreadsheetMetrics();
const coldCacheMiss = context.getDayDetails('2026-01-01');
assert.equal(coldCacheMiss.ok, true);
assert.equal(coldCacheMiss.data.items.length, 2);
assert.deepEqual(copySpreadsheetMetrics(), {
  openById: 1,
  getRange: 5,
  getValues: 1,
  getDisplayValues: 3,
  getMergedRanges: 1,
  getDisplayValue: 0,
});
const metricsAfterColdMiss = copySpreadsheetMetrics();
const hitAfterColdMiss = context.getDayDetails('2026-01-01');
assert.equal(hitAfterColdMiss.ok, true);
assert.deepEqual(copySpreadsheetMetrics(), metricsAfterColdMiss);

const secondValidSheet = makeScheduleSheet(2002, '831');
spreadsheetSheets = [targetSheet, secondValidSheet];
assert.equal(context.resolveCurrentScheduleSheet_().sheet.getSheetId(), 1730965450);

spreadsheetSheets = [descriptionSheet, targetSheet, secondValidSheet];
assert.equal(context.resolveCurrentScheduleSheet_().sheet.getSheetId(), 1730965450);

const whitespaceMarkerValues = makeFixture().map((row) => row.slice());
whitespaceMarkerValues[6][0] = ' 案件数 ';
const whitespaceMarkerSheet = new MockSheet(1997, whitespaceMarkerValues, { name: '不正マーカー' });
const invalidHeaderValues = makeFixture().map((row) => row.slice());
invalidHeaderValues[1].fill('', 12);
const invalidHeaderSheet = new MockSheet(1998, invalidHeaderValues, { name: '日付なし' });
spreadsheetSheets = [whitespaceMarkerSheet, invalidHeaderSheet, targetSheet];
assert.equal(context.resolveCurrentScheduleSheet_().sheet.getSheetId(), 1730965450);

const hiddenValidSheet = makeScheduleSheet(2000, '非表示の最新', { hidden: true });
spreadsheetSheets = [hiddenValidSheet, descriptionSheet, targetSheet];
assert.equal(context.resolveCurrentScheduleSheet_().sheet.getSheetId(), 1730965450);

const newestLeftSheet = makeScheduleSheet(3003, '914', {
  customer: '新しい左端タブの顧客',
  work: '新しい左端タブの作業',
});
spreadsheetSheets = [newestLeftSheet, targetSheet, secondValidSheet];
assert.equal(context.resolveCurrentScheduleSheet_().sheet.getSheetId(), 3003);

spreadsheetSheets = [targetSheet, newestLeftSheet, secondValidSheet];
assert.equal(context.resolveCurrentScheduleSheet_().sheet.getSheetId(), 1730965450);

newestLeftSheet.name = '名称変更後の任意タブ名';
spreadsheetSheets = [newestLeftSheet, targetSheet];
assert.equal(context.resolveCurrentScheduleSheet_().sheet.getSheetId(), 3003);

const futureDatedRightSheet = makeScheduleSheet(4004, '過去タブ', {
  firstHeader: '2035/12/31',
});
spreadsheetSheets = [targetSheet, futureDatedRightSheet];
assert.equal(context.resolveCurrentScheduleSheet_().sheet.getSheetId(), 1730965450);

spreadsheetSheets = [newestLeftSheet, targetSheet];
const activeCacheBeforeSheetSwitch = JSON.parse(
  userCache.values.get('day-details:active:v1'),
);
const newestCalendar = context.getCalendarData();
assert.equal(newestCalendar.ok, true);
assert.match(newestCalendar.data.spreadsheetUrl, /[?&]gid=3003$/);
const activeCacheAfterSheetSwitch = JSON.parse(
  userCache.values.get('day-details:active:v1'),
);
assert.equal(activeCacheAfterSheetSwitch.sheetId, '3003');
assert.notEqual(
  activeCacheAfterSheetSwitch.generation,
  activeCacheBeforeSheetSwitch.generation,
);
const metricsBeforeNewestDetails = copySpreadsheetMetrics();
const newestDetails = context.getDayDetails('2025-12-31');
assert.equal(newestDetails.ok, true);
assert.equal(newestDetails.data.items[0].customer, '新しい左端タブの顧客');
assert.equal(newestDetails.data.items[0].work, '新しい左端タブの作業');
assert.deepEqual(copySpreadsheetMetrics(), metricsBeforeNewestDetails);

spreadsheetSheets = [descriptionSheet, hiddenValidSheet];
assert.deepEqual(
  JSON.parse(JSON.stringify(context.getCalendarData())),
  { ok: false, error: { code: 'DATA_FETCH_FAILED' } },
);

spreadsheetSheets = [descriptionSheet, targetSheet];
assert.equal(context.getCalendarData().ok, true);

const newYearDetailsResponse = context.getDayDetails('2026-01-01');
assert.equal(newYearDetailsResponse.ok, true);
const newYearDetails = newYearDetailsResponse.data;
assert.equal(newYearDetails.items.length, 2);
assert.deepEqual(
  Array.from(newYearDetails.items, (item) => ({ ...item })),
  [
    { customer: '顧客A', content: 'ギフト箱', work: 'デザイン', period: 'PM' },
    { customer: '', content: '内容のみ', work: 'サンプル', period: 'AM' },
  ],
);
assert.ok(newYearDetails.items.every((item) => item.work !== 'KCP' && item.work !== '除外'));

const januarySecond = context.getDayDetails('2026-01-02').data;
assert.deepEqual(
  Array.from(januarySecond.items, (item) => ({ ...item })),
  [
    { customer: '顧客A', content: 'ギフト箱', work: '印刷', period: 'AM' },
    { customer: '', content: '内容のみ', work: 'KCP', period: 'AM' },
    { customer: '客先のみ', content: '内容のみ', work: '納品', period: 'PM' },
  ],
);
assert.ok(januarySecond.items.every((item) => item.period === 'AM' || item.period === 'PM'));

const workTypeCases = [
  ['印刷', true],
  ['工場', true],
  ['組立', true],
  ['梱包', true],
  ['CAD', true],
  ['デザイン', false],
  ['サンプル', false],
  ['納品', false],
  ['シート入', false],
  ['試作提出', false],
  ['中山', false],
  ['KCP', false],
  ['出荷', false],
  ['', false],
  ['  \t印刷\u3000', true],
  ['印刷確認', false],
];
workTypeCases.forEach(([value, expected]) => {
  assert.equal(context.isCountedWorkType_(value), expected, `work type: ${JSON.stringify(value)}`);
});
assert.deepEqual(
  Array.from(vm.runInContext('COUNTED_WORK_TYPES', context)),
  ['印刷', '工場', '組立', '梱包', 'CAD'],
);

const mixedValues = makeFixture().map((row) => row.slice());
for (let column = 13; column <= 16; column += 1) mixedValues[1][column] = '2026/9/10';
for (let row = 2; row <= 5; row += 1) {
  for (let column = 13; column <= 16; column += 1) mixedValues[row][column] = '';
}
['デザイン', '印刷', 'CAD', '納品', '工場', 'サンプル'].forEach((work, index) => {
  const row = 2 + Math.floor(index / 4);
  const column = 13 + (index % 4);
  mixedValues[row][column] = work;
});
spreadsheetSheets = [new MockSheet(5005, mixedValues, { name: '混在日' })];
const mixedCalendar = context.getCalendarData().data;
assert.deepEqual(
  Array.from(mixedCalendar.days, (day) => ({ ...day })),
  [{ date: '2026-09-10', count: 3, level: 2, symbol: '△' }],
);
spreadsheetSheets = [descriptionSheet, targetSheet];

const mergedDetailsSheet = makeMergedDetailsSheet();
spreadsheetSheets = [mergedDetailsSheet];
assert.equal(context.getCalendarData().ok, true);
const metricsBeforeMergedDetailsHit = copySpreadsheetMetrics();
const mergedDetails = context.getDayDetails('2026-09-10').data;
assert.deepEqual(
  Array.from(mergedDetails.items, (item) => ({ ...item })),
  [
    { customer: '', content: '', work: '納品', period: 'PM' },
    { customer: '高井屋', content: 'DINOサブレ箱', work: '印刷', period: 'PM' },
    { customer: '高井屋', content: 'DINOサブレ箱', work: 'デザイン', period: 'AM' },
    { customer: '高井屋', content: 'DINOサブレ箱', work: '出荷', period: 'PM' },
  ],
);
assert.ok(mergedDetails.items.every((item) => (
  Object.keys(item).sort().join(',') === 'content,customer,period,work'
)));
assert.ok(mergedDetails.items.every((item) => item.period === 'AM' || item.period === 'PM'));
assert.deepEqual(copySpreadsheetMetrics(), metricsBeforeMergedDetailsHit);
assert.equal(context.normalizePeriod_('AM'), 'AM');
assert.equal(context.normalizePeriod_('ＰＭ'), 'PM');
assert.equal(context.normalizePeriod_(''), '');
assert.equal(context.normalizePeriod_('不明'), '');
spreadsheetSheets = [descriptionSheet, targetSheet];
assert.equal(context.getCalendarData().ok, true);

assert.deepEqual(
  JSON.parse(JSON.stringify(context.getDayDetails('2026-02-30'))),
  { ok: false, error: { code: 'DATA_FETCH_FAILED' } },
);
assert.deepEqual(
  JSON.parse(JSON.stringify(context.getDayDetails('2026\/01\/01'))),
  { ok: false, error: { code: 'DATA_FETCH_FAILED' } },
);

userCache.clear();
spreadsheetError = new Error(
  'You do not have permission to access the requested document. Sensitive Google details.',
);
const calendarDenied = context.getCalendarData();
assert.deepEqual(
  JSON.parse(JSON.stringify(calendarDenied)),
  { ok: false, error: { code: 'ACCESS_DENIED' } },
);
assert.doesNotMatch(JSON.stringify(calendarDenied), /permission|Sensitive|Google details/i);
const detailDenied = context.getDayDetails('2026-01-01');
assert.deepEqual(
  JSON.parse(JSON.stringify(detailDenied)),
  { ok: false, error: { code: 'ACCESS_DENIED' } },
);
assert.doesNotMatch(JSON.stringify(detailDenied), /permission|Sensitive|Google details/i);

spreadsheetError = new Error(
  'Service invoked too many times: Spreadsheet. Internal transient details.',
);
const transientFailure = context.getCalendarData();
assert.deepEqual(
  JSON.parse(JSON.stringify(transientFailure)),
  { ok: false, error: { code: 'DATA_FETCH_FAILED' } },
);
assert.doesNotMatch(JSON.stringify(transientFailure), /Service invoked|Internal transient/i);
spreadsheetError = null;

const parsed = context.parseDateHeaders_(
  ['12/30', '12/31', '1/1', '1/2', '2027/2/1', '', '不正'],
  new Date(2026, 11, 1),
);
assert.deepEqual(
  Array.from(parsed, (date) => (date ? formatDate(date) : null)),
  ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-02-01', null, null],
);
assert.deepEqual(
  [0, 1, 2, 3, 4, 5, 6, 7, 99].map((count) => context.getCongestionLevel_(count)),
  [0, 1, 1, 2, 2, 3, 3, 3, 3],
);
assert.deepEqual(
  [0, 1, 2, 3, 4, 5, 6, 7, 99].map((count) => context.getCongestionRule_(count).symbol),
  ['◎', '○', '○', '△', '△', '×', '×', '×', '×'],
);

const spreadsheetWritePattern = /\.(?:setValue|setValues|appendRow|insert(?:Row|Rows|Column|Columns|Sheet)|delete(?:Row|Rows|Column|Columns|Sheet)|moveActiveSheet|copyTo|setActiveSheet|activate|hideSheet|showSheet|clear(?:Content|Format|Note|DataValidations)?|setFormula|setFormulas|setNumberFormat|setBackground|setFont|setBorder|mergeCells|breakApart)\s*\(/g;
assert.deepEqual(serverSource.match(spreadsheetWritePattern), null);
assert.equal((serverSource.match(/const COUNTED_WORK_TYPES\s*=/g) || []).length, 1);
assert.match(serverSource, /COUNTED_WORK_TYPES\.includes\(trimmed_\(value\)\)/);
assert.match(serverSource, /getMergedRanges\(\)/);
assert.doesNotMatch(serverSource, /isPm_|isAm_/);
assert.match(serverSource, /CacheService\.getUserCache\(\)/);
assert.doesNotMatch(serverSource, /getScriptCache\(\)|getDocumentCache\(\)|PropertiesService/);
assert.match(serverSource, /detailCacheTtlSeconds:\s*75/);
assert.match(serverSource, /generation = `\$\{sheetId\}:/);
assert.doesNotMatch(serverSource, /1730965450/);
assert.doesNotMatch(serverSource, /getScheduleLayout_|CALENDAR_CONFIG\.sheetId/);
assert.equal((serverSource.match(/resolveCurrentScheduleSheet_\(\)/g) || []).length, 3);
assert.equal(vm.runInContext('CALENDAR_CONFIG.periodColumn', context), 13);
assert.equal(vm.runInContext('CALENDAR_CONFIG.dateStartColumn', context), 14);
assert.match(serverSource, /buildSpreadsheetUrl_\(layout\.sheetId\)/);
assert.match(serverSource, /for \(let index = 0; index < sheets\.length; index \+= 1\)/);
assert.doesNotMatch(serverSource, /getName\(\)/);

assert.match(htmlSource, /元のダンプロスケジュールを開く ↗/);
assert.match(htmlSource, /target="_blank"/);
assert.match(htmlSource, /id="source-link"[\s\S]*?rel="noopener noreferrer"[\s\S]*?hidden/);
assert.doesNotMatch(htmlSource, /docs\.google\.com\/spreadsheets\/d\/1KOH/);
assert.match(htmlSource, /showSourceLink\(data\.spreadsheetUrl\)/);
assert.match(htmlSource, /elements\.sourceLink\.hidden = false/);
assert.match(htmlSource, /function hideSourceLink\(\)[\s\S]*?removeAttribute\('href'\)/);
assert.doesNotMatch(htmlSource, /枠/);
assert.doesNotMatch(htmlSource, /item\.count/);
assert.match(htmlSource, /const LEVEL_SYMBOLS = \['◎', '○', '△', '×'\]/);
assert.equal((htmlSource.match(/--level-[0-3]:/g) || []).length, 4);
assert.doesNotMatch(htmlSource, /level-4/);
assert.match(htmlSource, />社員用</);
assert.match(htmlSource, /role="dialog"/);
assert.match(htmlSource, /aria-modal="true"/);
assert.match(htmlSource, /このページを表示する権限がありません。\\nダンプロスケジュールへのアクセス権限を確認してください。/);
assert.match(htmlSource, /データを取得できませんでした。しばらくしてから再度お試しください。/);
assert.match(htmlSource, /詳細情報を表示する権限がありません。/);
assert.match(htmlSource, /詳細情報を取得できませんでした。しばらくしてから再度お試しください。/);
assert.match(htmlSource, /\(hover: hover\) and \(pointer: fine\)/);
assert.match(htmlSource, /pointerenter/);
assert.match(htmlSource, /visibilitychange/);
assert.match(htmlSource, /REFRESH_INTERVAL_MS = 60 \* 1000/);
assert.match(htmlSource, /detailCache\.clear\(\)/);
assert.doesNotMatch(htmlSource, /localStorage|sessionStorage|https:\/\/(?!docs\.google\.com)/);
assert.doesNotMatch(htmlSource, /error\.message|Sensitive Google details|Service invoked too many times/);
assert.match(htmlSource, /withFailureHandler\(\(\) => reject\(\{ code: ERROR_CODES\.dataFetchFailed \}\)\)/);
assert.equal((htmlSource.match(/\.getDayDetails\(dateKey\)/g) || []).length, 1);
assert.equal((htmlSource.match(/\.getCalendarData\(\)/g) || []).length, 1);
assert.deepEqual(
  Array.from(
    htmlSource.matchAll(/<div class="weekday(?: (?:sunday|saturday))?">([^<]+)<\/div>/g),
    (match) => match[1],
  ),
  ['日', '月', '火', '水', '木', '金', '土'],
);
assert.match(htmlSource, /const firstDayOffset = firstDay\.getDay\(\)/);
assert.doesNotMatch(htmlSource, /mondayOffset/);
assert.doesNotThrow(() => new vm.Script(browserScript, { filename: 'Index.html<script>' }));

async function testClientBehavior() {
  const success = runClientScenario({ calendarResponse: makeCalendarPayload() });
  assert.equal(success.elements.get('source-link').hidden, false);
  assert.equal(
    success.elements.get('source-link').href,
    'https://docs.google.com/spreadsheets/d/safe-test-id/edit?gid=1730965450',
  );
  assert.equal(success.elements.get('error').hidden, true);
  const calendarButton = success.elements
    .get('calendar-grid')
    .children
    .find((element) => element.dataset.date === '2026-09-08');
  assert.ok(calendarButton);
  assert.equal(calendarButton.children[1].textContent, '○');
  assert.equal(calendarButton.children[1].className, 'congestion-symbol');
  assert.equal(calendarButton.classes.has('level-1'), true);
  assert.equal(calendarButton.attributes['aria-label'], '2026年9月8日、○ 対応可能。詳細を表示');
  assert.doesNotMatch(calendarButton.children.map((child) => child.textContent).join(' '), /枠/);
  assert.deepEqual(
    success.elements.get('legend').children.map((entry) => [
      entry.children[0].textContent,
      entry.children[1].textContent,
    ]),
    [['◎', '余裕あり'], ['○', '対応可能'], ['△', 'やや混雑'], ['×', '混雑']],
  );

  const sundayStart = runClientScenario({
    calendarResponse: makeCalendarPayload([makeCalendarDay('2025-06-01', 1)]),
  });
  assert.equal(sundayStart.elements.get('calendar-grid').children[0].dataset.date, '2025-06-01');

  const mondayStart = runClientScenario({
    calendarResponse: makeCalendarPayload([makeCalendarDay('2025-09-01', 1)]),
  });
  assert.equal(mondayStart.elements.get('calendar-grid').children[1].dataset.date, '2025-09-01');
  assert.equal(mondayStart.elements.get('calendar-grid').children[0].children.length, 0);
  assert.equal(mondayStart.elements.get('calendar-grid').children[0].className, 'day outside');

  const thresholdDays = [
    makeCalendarDay('2026-09-07', 0),
    makeCalendarDay('2026-09-08', 1),
    makeCalendarDay('2026-09-09', 2),
    makeCalendarDay('2026-09-10', 3),
    makeCalendarDay('2026-09-11', 4),
    makeCalendarDay('2026-09-14', 5),
    makeCalendarDay('2026-09-05', 0),
    makeCalendarDay('2026-09-06', 0),
    makeCalendarDay('2026-09-12', 1),
    makeCalendarDay('2026-09-13', 3),
    makeCalendarDay('2026-09-19', 5),
    makeCalendarDay('2026-09-20', 2),
    makeCalendarDay('2026-09-26', 4),
    makeCalendarDay('2026-09-27', 6),
  ];
  const thresholdUi = runClientScenario({
    calendarResponse: makeCalendarPayload(thresholdDays),
    hoverCapable: true,
    detailResponse: { ok: true, data: { date: '2026-09-12', items: [] } },
  });
  const thresholdCells = new Map(
    thresholdUi.elements.get('calendar-grid').children
      .filter((element) => element.dataset.date)
      .map((element) => [element.dataset.date, element]),
  );
  [
    ['2026-09-07', '◎', 'level-0'],
    ['2026-09-08', '○', 'level-1'],
    ['2026-09-09', '○', 'level-1'],
    ['2026-09-10', '△', 'level-2'],
    ['2026-09-11', '△', 'level-2'],
    ['2026-09-14', '×', 'level-3'],
    ['2026-09-12', '○', 'level-1'],
    ['2026-09-13', '△', 'level-2'],
    ['2026-09-19', '×', 'level-3'],
    ['2026-09-20', '○', 'level-1'],
    ['2026-09-26', '△', 'level-2'],
    ['2026-09-27', '×', 'level-3'],
  ].forEach(([date, symbol, levelClass]) => {
    const cell = thresholdCells.get(date);
    assert.ok(cell, `interactive day: ${date}`);
    assert.equal(cell.children[1].textContent, symbol, `symbol: ${date}`);
    assert.equal(cell.classes.has(levelClass), true, `heatmap: ${date}`);
    assert.ok(cell.listeners.click, `click: ${date}`);
    assert.ok(cell.listeners.pointerenter, `hover: ${date}`);
  });
  ['2026-09-05', '2026-09-06'].forEach((date) => {
    const cell = thresholdUi.elements.get('calendar-grid').children.find((candidate) => (
      candidate.children[0] && candidate.attributes['aria-label'] === `${Number(date.slice(-2)) === 5 ? '2026年9月5日' : '2026年9月6日'}、休業日`
    ));
    assert.ok(cell, `idle weekend: ${date}`);
    assert.equal(cell.children.length, 1, `date number only: ${date}`);
    assert.equal(cell.classes.has('level-0'), false, `no heatmap: ${date}`);
    assert.equal(Boolean(cell.listeners.click), false, `no click: ${date}`);
    assert.equal(Boolean(cell.listeners.pointerenter), false, `no hover: ${date}`);
    assert.equal('date' in cell.dataset, false, `no interactive date: ${date}`);
  });
  const workingSaturday = thresholdCells.get('2026-09-12');
  await workingSaturday.listeners.click[0]();
  assert.equal(thresholdUi.elements.get('detail-backdrop').hidden, false);
  assert.deepEqual(thresholdUi.calls.details, ['2026-09-12']);
  assert.equal(thresholdUi.elements.get('calendar-grid').children
    .find((element) => element.children[0]?.textContent === 10)
    .attributes['aria-current'], 'date');

  assert.equal(thresholdUi.intervals.length, 1);
  assert.equal(thresholdUi.intervals[0].milliseconds, 60 * 1000);
  assert.equal(thresholdUi.calls.calendar, 1);
  thresholdUi.intervals[0].callback();
  assert.equal(thresholdUi.calls.calendar, 2);
  thresholdUi.documentListeners.visibilitychange[0]();
  assert.equal(thresholdUi.calls.calendar, 3);

  const rolloverUi = runClientScenario({
    calendarResponse: makeCalendarPayload([makeCalendarDay('2025-12-15', 0)]),
  });
  assert.equal(rolloverUi.elements.get('month-title').textContent, '2025年 12月');
  rolloverUi.elements.get('next-month').listeners.click[0]();
  assert.equal(rolloverUi.elements.get('month-title').textContent, '2026年 1月');
  rolloverUi.elements.get('previous-month').listeners.click[0]();
  rolloverUi.elements.get('previous-month').listeners.click[0]();
  assert.equal(rolloverUi.elements.get('month-title').textContent, '2025年 11月');
  rolloverUi.elements.get('today').listeners.click[0]();
  assert.equal(rolloverUi.elements.get('month-title').textContent, '2026年 9月');

  const hoverUi = runClientScenario({
    calendarResponse: makeCalendarPayload(),
    hoverCapable: true,
    detailResponse: {
      ok: true,
      data: {
        date: '2026-09-08',
        items: [
          { customer: '高井屋', content: 'DINOサブレ箱', work: '印刷', period: 'PM' },
          { customer: '東洋染化', content: '', work: 'シート入', period: 'AM' },
          { customer: '期間未設定', content: '', work: '梱包', period: '' },
        ],
      },
    },
  });
  const hoverButton = hoverUi.elements
    .get('calendar-grid')
    .children
    .find((element) => element.dataset.date === '2026-09-08');
  assert.ok(hoverButton.listeners.pointerenter);
  hoverButton.listeners.pointerenter[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hoverUi.elements.get('hover-preview').hidden, false);
  assert.equal(hoverUi.elements.get('hover-preview').children[0].textContent, '9月8日（火）');
  assert.deepEqual(
    hoverUi.elements.get('hover-preview').children[1].children.map((item) => item.textContent),
    ['高井屋：印刷（午後）', '東洋染化：シート入（午前）', '期間未設定：梱包'],
  );

  const modalUi = runClientScenario({
    calendarResponse: makeCalendarPayload(),
    detailResponse: {
      ok: true,
      data: {
        date: '2026-09-08',
        items: [
          { customer: '高井屋', content: 'DINOサブレ箱', work: '印刷', period: 'PM' },
          { customer: '東洋染化', content: '', work: 'シート入', period: 'AM' },
          { customer: '期間未設定', content: '', work: '梱包' },
        ],
      },
    },
  });
  const modalButton = modalUi.elements
    .get('calendar-grid')
    .children
    .find((element) => element.dataset.date === '2026-09-08');
  await modalButton.listeners.click[0]();
  const modalCards = modalUi.elements.get('detail-body').children[0].children;
  assert.deepEqual(
    modalCards.map((card) => [card.children[0].textContent, card.children[1].textContent]),
    [
      ['高井屋 / DINOサブレ箱', '印刷（午後）'],
      ['東洋染化', 'シート入（午前）'],
      ['期間未設定', '梱包'],
    ],
  );

  const denied = runClientScenario({
    calendarResponse: { ok: false, error: { code: 'ACCESS_DENIED' } },
  });
  assert.equal(denied.elements.get('source-link').hidden, true);
  assert.equal('href' in denied.elements.get('source-link'), false);
  assert.equal(
    denied.elements.get('error').textContent,
    'このページを表示する権限がありません。\nダンプロスケジュールへのアクセス権限を確認してください。',
  );

  const transient = runClientScenario({
    calendarResponse: { ok: false, error: { code: 'DATA_FETCH_FAILED' } },
  });
  assert.equal(transient.elements.get('source-link').hidden, true);
  assert.equal(
    transient.elements.get('error').textContent,
    'データを取得できませんでした。しばらくしてから再度お試しください。',
  );

  const rawFailure = runClientScenario({ calendarFailure: 'RAW GOOGLE ERROR: secret details' });
  assert.equal(rawFailure.elements.get('source-link').hidden, true);
  assert.doesNotMatch(rawFailure.elements.get('error').textContent, /RAW GOOGLE ERROR|secret/i);

  const detailDeniedUi = runClientScenario({
    calendarResponse: makeCalendarPayload(),
    detailResponse: { ok: false, error: { code: 'ACCESS_DENIED' } },
  });
  const dateButton = detailDeniedUi.elements
    .get('calendar-grid')
    .children
    .find((element) => element.dataset.date === '2026-09-08');
  assert.ok(dateButton);
  await dateButton.listeners.click[0]();
  assert.equal(
    detailDeniedUi.elements.get('detail-body').children[0].textContent,
    '詳細情報を表示する権限がありません。',
  );
  assert.equal(detailDeniedUi.elements.get('error').hidden, true);
  assert.equal(detailDeniedUi.elements.get('source-link').hidden, false);
}

testClientBehavior().then(() => {
  console.log('PASS: Sunday-first headers and month-start offsets for Sunday and Monday');
  console.log('PASS: weekday/weekend thresholds, idle-weekend neutrality, and interaction gating');
  console.log('PASS: previous/next/today navigation, year rollover, 60-second and visibility refresh');
  console.log('PASS: exact-match counted work types, revised thresholds, four levels and symbols');
  console.log('PASS: merged customer/content lookup, no cross-case inheritance, AM/PM conversion');
  console.log('PASS: detail cache hit performs zero Spreadsheet reads; cache miss bulk-loads safely');
  console.log('PASS: leftmost sheet switch rotates the sheetId-scoped cache generation');
  console.log('PASS: month/year rollover and invalid-date rejection');
  console.log('PASS: no Spreadsheet write calls or browser persistence; user cache TTL is 75 seconds');
  console.log('PASS: safe ACCESS_DENIED / transient error envelopes without raw Google messages');
  console.log('PASS: leftmost valid visible schedule follows tab insertion, reorder, and rename');
  console.log('PASS: calendar, day details, and Spreadsheet gid share the same resolver');
  console.log('PASS: initial success reveals link; initial failures keep URL absent and link hidden');
  console.log('PASS: AM/PM and missing-period formatting in hover preview and detail modal');
  console.log('PASS: permission messages, hover preview, and getDayDetails modal-only error handling');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
