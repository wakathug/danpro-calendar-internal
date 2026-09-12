const CALENDAR_CONFIG = Object.freeze({
  spreadsheetId: '1KOHReFlDdmJvLWX16Qram6TSogWMXwW4ddWRI6uWjfY',
  timeZone: 'Asia/Tokyo',
  headerRow: 2,
  dataStartRow: 3,
  dateStartColumn: 13,
  customerColumn: 5,
  contentColumn: 8,
  periodColumn: 12,
  endMarker: '案件数',
  detailCacheTtlSeconds: 75,
  detailCacheActiveKey: 'day-details:active:v1',
  detailCacheKeyPrefix: 'day-details:v1:',
  detailCacheMaxValueChars: 24000,
  levels: Object.freeze([
    Object.freeze({ level: 0, max: 0, symbol: '◎', label: '余裕あり' }),
    Object.freeze({ level: 1, max: 2, symbol: '○', label: '対応可能' }),
    Object.freeze({ level: 2, max: 4, symbol: '△', label: 'やや混雑' }),
    Object.freeze({ level: 3, max: Infinity, symbol: '×', label: '混雑' }),
  ]),
});

const COUNTED_WORK_TYPES = Object.freeze([
  '印刷',
  '工場',
  '組立',
  '梱包',
  'CAD',
]);

const SAFE_ERROR_CODES = Object.freeze({
  accessDenied: 'ACCESS_DENIED',
  dataFetchFailed: 'DATA_FETCH_FAILED',
});

/** @return {HtmlOutput} */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('ダンプロ 混雑見込みカレンダー（社員用）')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/**
 * 呼び出しごとに本番Spreadsheetを読み取り、日付・集計対象工程数・混雑度だけを返します。
 * 顧客名や案件内容などの明細は返しません。
 *
 * @return {{ok: boolean, data: Object}|{ok: false, error: {code: string}}}
 */
function getCalendarData() {
  try {
    return { ok: true, data: getCalendarData_() };
  } catch (error) {
    return createSafeErrorResponse_(error);
  }
}

/**
 * @return {{days: Array<{date: string, count: number, level: number, symbol: string}>,
 *   levels: Array<{level: number, symbol: string, label: string}>, updatedAt: string,
 *   timeZone: string, spreadsheetUrl: string}}
 */
function getCalendarData_() {
  const layout = resolveCurrentScheduleSheet_();
  const snapshot = readScheduleSnapshot_(layout);
  cacheDayDetailsSnapshot_(layout.sheetId, snapshot.detailsByDate, snapshot.updatedAt);

  const days = Object.keys(snapshot.countsByDate)
    .sort()
    .map((date) => {
      const count = snapshot.countsByDate[date];
      const congestion = getCongestionRule_(count);
      return {
        date,
        count,
        level: congestion.level,
        symbol: congestion.symbol,
      };
    });

  if (days.length === 0) {
    throw new Error('M列以降の2行目に有効な日付が見つかりません。');
  }

  return {
    days,
    levels: CALENDAR_CONFIG.levels.map((rule) => ({
      level: rule.level,
      symbol: rule.symbol,
      label: rule.label,
    })),
    updatedAt: snapshot.updatedAt,
    timeZone: CALENDAR_CONFIG.timeZone,
    spreadsheetUrl: buildSpreadsheetUrl_(layout.sheetId),
  };
}

/**
 * 指定された1日分だけの案件詳細を読み取ります。
 * 返す項目は客先名、内容、当日の作業内容、AM/PMの日本語表記に限定します。
 *
 * @param {string} dateKey yyyy-MM-dd形式の日付
 * @return {{ok: boolean, data: Object}|{ok: false, error: {code: string}}}
 */
function getDayDetails(dateKey) {
  try {
    return { ok: true, data: getDayDetails_(dateKey) };
  } catch (error) {
    return createSafeErrorResponse_(error);
  }
}

/**
 * @param {string} dateKey yyyy-MM-dd形式の日付
 * @return {{date: string,
 *   items: Array<{customer: string, content: string, work: string, period: string}>,
 *   updatedAt: string}}
 */
function getDayDetails_(dateKey) {
  const normalizedDateKey = normalizeDateKey_(dateKey);
  if (!normalizedDateKey) {
    throw new Error('日付はyyyy-MM-dd形式で指定してください。');
  }

  const cached = getCachedDayDetails_(normalizedDateKey);
  if (cached) return cached;

  const layout = resolveCurrentScheduleSheet_();
  const snapshot = readScheduleSnapshot_(layout);
  cacheDayDetailsSnapshot_(layout.sheetId, snapshot.detailsByDate, snapshot.updatedAt);
  return {
    date: normalizedDateKey,
    items: snapshot.detailsByDate[normalizedDateKey] || [],
    updatedAt: snapshot.updatedAt,
  };
}

/**
 * Google側の生エラーや内部情報を返さず、安全なエラーコードだけへ変換します。
 *
 * @param {*} error
 * @return {{ok: false, error: {code: string}}}
 */
function createSafeErrorResponse_(error) {
  return {
    ok: false,
    error: {
      code: isAccessDeniedError_(error)
        ? SAFE_ERROR_CODES.accessDenied
        : SAFE_ERROR_CODES.dataFetchFailed,
    },
  };
}

/**
 * Apps Script / Google APIの文言差と日本語・英語の双方をサーバー内だけで判定します。
 *
 * @param {*} error
 * @return {boolean}
 */
function isAccessDeniedError_(error) {
  const message = String(error && error.message ? error.message : error || '');
  return [
    /permission/i,
    /access[\s_-]*denied/i,
    /not (?:have|authorized).*access/i,
    /authorization (?:is )?required/i,
    /insufficient.*(?:permission|authentication)/i,
    /権限/,
    /アクセス.*(?:拒否|できません|ありません)/,
  ].some((pattern) => pattern.test(message));
}

/**
 * Spreadsheetの現在の表示順を左から確認し、最初の有効なスケジュールを返します。
 * タブ名・日付の新旧・固定sheetIdには依存しません。
 *
 * @return {{sheet: Sheet, sheetId: number, dataRowCount: number,
 *   dateColumnCount: number, parsedHeaders: Array<?Date>}}
 */
function resolveCurrentScheduleSheet_() {
  const spreadsheet = SpreadsheetApp.openById(CALENDAR_CONFIG.spreadsheetId);
  const sheets = spreadsheet.getSheets();
  const now = new Date();
  for (let index = 0; index < sheets.length; index += 1) {
    const layout = inspectScheduleSheet_(sheets[index], now);
    if (layout) return layout;
  }

  throw new Error('有効なスケジュールシートが見つかりません。');
}

/**
 * 1枚のシートが運用中のスケジュール形式を満たすか、読み取りだけで検査します。
 *
 * @param {Sheet} sheet
 * @param {Date} now
 * @return {?{sheet: Sheet, sheetId: number, dataRowCount: number,
 *   dateColumnCount: number, parsedHeaders: Array<?Date>}}
 */
function inspectScheduleSheet_(sheet, now) {
  if (sheet.isSheetHidden()) return null;

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (
    lastRow <= CALENDAR_CONFIG.dataStartRow
    || lastColumn < CALENDAR_CONFIG.dateStartColumn
  ) return null;

  const markerValues = sheet
    .getRange(
      CALENDAR_CONFIG.dataStartRow,
      1,
      lastRow - CALENDAR_CONFIG.dataStartRow + 1,
      1,
    )
    .getDisplayValues();
  const markerOffset = markerValues.findIndex(
    (row) => String(row[0] == null ? '' : row[0]) === CALENDAR_CONFIG.endMarker,
  );
  if (markerOffset <= 0) return null;

  const dateColumnCount = lastColumn - CALENDAR_CONFIG.dateStartColumn + 1;
  const headerValues = sheet
    .getRange(
      CALENDAR_CONFIG.headerRow,
      CALENDAR_CONFIG.dateStartColumn,
      1,
      dateColumnCount,
    )
    .getValues()[0];
  const parsedHeaders = parseDateHeaders_(headerValues, now);
  if (!parsedHeaders.some((date) => Boolean(date))) return null;

  return {
    sheet,
    sheetId: sheet.getSheetId(),
    dataRowCount: markerOffset,
    dateColumnCount,
    parsedHeaders,
  };
}

/** @return {string} */
function buildSpreadsheetUrl_(sheetId) {
  return `https://docs.google.com/spreadsheets/d/${CALENDAR_CONFIG.spreadsheetId}/edit?gid=${sheetId}`;
}

/**
 * E列から日付領域末尾までを1回で読み取り、混雑数と日付別詳細を同時に作成します。
 * 結合範囲はE〜H列を1回だけ調べ、E/H列の空欄値を左上値で補完します。
 *
 * @param {{sheet: Sheet, sheetId: number, dataRowCount: number,
 *   dateColumnCount: number, parsedHeaders: Array<?Date>}} layout
 * @return {{countsByDate: Object<string, number>,
 *   detailsByDate: Object<string, Array<Object>>, updatedAt: string}}
 */
function readScheduleSnapshot_(layout) {
  const startRow = CALENDAR_CONFIG.dataStartRow;
  const startColumn = CALENDAR_CONFIG.customerColumn;
  const lastColumn = CALENDAR_CONFIG.dateStartColumn + layout.dateColumnCount - 1;
  const columnCount = lastColumn - startColumn + 1;
  const updatedAt = new Date().toISOString();
  const countsByDate = {};
  const detailsByDate = {};
  const dateKeys = layout.parsedHeaders.map((date) => {
    if (!date) return null;
    const dateKey = formatDateKey_(date);
    if (!Object.prototype.hasOwnProperty.call(countsByDate, dateKey)) {
      countsByDate[dateKey] = 0;
      detailsByDate[dateKey] = [];
    }
    return dateKey;
  });

  if (layout.dataRowCount === 0) {
    return { countsByDate, detailsByDate, updatedAt };
  }

  const dataValues = layout.sheet
    .getRange(startRow, startColumn, layout.dataRowCount, columnCount)
    .getDisplayValues();
  const mergedRanges = layout.sheet
    .getRange(
      startRow,
      CALENDAR_CONFIG.customerColumn,
      layout.dataRowCount,
      CALENDAR_CONFIG.contentColumn - CALENDAR_CONFIG.customerColumn + 1,
    )
    .getMergedRanges();
  const customerValues = resolveMergedDisplayColumn_(
    dataValues,
    startRow,
    startColumn,
    CALENDAR_CONFIG.customerColumn,
    mergedRanges,
  );
  const contentValues = resolveMergedDisplayColumn_(
    dataValues,
    startRow,
    startColumn,
    CALENDAR_CONFIG.contentColumn,
    mergedRanges,
  );
  const periodOffset = CALENDAR_CONFIG.periodColumn - startColumn;
  const scheduleOffset = CALENDAR_CONFIG.dateStartColumn - startColumn;

  dataValues.forEach((row, rowOffset) => {
    const period = normalizePeriod_(row[periodOffset]);
    dateKeys.forEach((dateKey, dateColumnOffset) => {
      if (!dateKey) return;
      const work = trimmed_(row[scheduleOffset + dateColumnOffset]);
      if (isCountedWorkType_(work)) countsByDate[dateKey] += 1;
      if (work) {
        detailsByDate[dateKey].push({
          customer: customerValues[rowOffset],
          content: contentValues[rowOffset],
          work,
          period,
        });
      }
    });
  });

  return { countsByDate, detailsByDate, updatedAt };
}

/**
 * 一括読み取り済みの表示値に、指定列の結合セル左上値を反映します。
 *
 * @return {Array<string>}
 */
function resolveMergedDisplayColumn_(dataValues, startRow, startColumn, column, mergedRanges) {
  const endRow = startRow + dataValues.length - 1;
  const values = dataValues.map((row) => trimmed_(row[column - startColumn]));

  mergedRanges.forEach((mergedRange) => {
    if (column < mergedRange.getColumn() || column > mergedRange.getLastColumn()) return;

    const topRowOffset = mergedRange.getRow() - startRow;
    const topColumnOffset = mergedRange.getColumn() - startColumn;
    const topLeftIsLoaded = topRowOffset >= 0
      && topRowOffset < dataValues.length
      && topColumnOffset >= 0
      && topColumnOffset < dataValues[0].length;
    const mergedValue = trimmed_(topLeftIsLoaded
      ? dataValues[topRowOffset][topColumnOffset]
      : mergedRange.getDisplayValue());
    const firstRow = Math.max(startRow, mergedRange.getRow());
    const lastRow = Math.min(endRow, mergedRange.getLastRow());
    for (let row = firstRow; row <= lastRow; row += 1) {
      const rowOffset = row - startRow;
      if (values[rowOffset] === '') values[rowOffset] = mergedValue;
    }
  });

  return values;
}

/**
 * 日付別詳細を現在ユーザー専用キャッシュへ保存し、最後に現行世代を切り替えます。
 * 世代にsheetIdを含めるため、左端タブ切替後の更新で旧タブの詳細は参照されません。
 */
function cacheDayDetailsSnapshot_(sheetId, detailsByDate, updatedAt) {
  try {
    const cache = CacheService.getUserCache();
    const generation = `${sheetId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
    const cacheValues = {};
    Object.keys(detailsByDate).forEach((date) => {
      const serialized = JSON.stringify({ date, items: detailsByDate[date], updatedAt });
      if (serialized.length <= CALENDAR_CONFIG.detailCacheMaxValueChars) {
        cacheValues[buildDayDetailsCacheKey_(generation, date)] = serialized;
      }
    });
    if (Object.keys(cacheValues).length > 0) {
      cache.putAll(cacheValues, CALENDAR_CONFIG.detailCacheTtlSeconds);
    }
    cache.put(
      CALENDAR_CONFIG.detailCacheActiveKey,
      JSON.stringify({ generation, sheetId: String(sheetId) }),
      CALENDAR_CONFIG.detailCacheTtlSeconds,
    );
  } catch (error) {
    console.warn('day details cache write skipped');
  }
}

/** @return {?{date: string, items: Array<Object>, updatedAt: string}} */
function getCachedDayDetails_(dateKey) {
  try {
    const cache = CacheService.getUserCache();
    const activeText = cache.get(CALENDAR_CONFIG.detailCacheActiveKey);
    if (!activeText) return null;
    const active = JSON.parse(activeText);
    if (!active || typeof active.generation !== 'string') return null;
    const cachedText = cache.get(buildDayDetailsCacheKey_(active.generation, dateKey));
    if (!cachedText) return null;
    const cached = JSON.parse(cachedText);
    if (!cached || cached.date !== dateKey || !Array.isArray(cached.items)) return null;
    return cached;
  } catch (error) {
    return null;
  }
}

/** @return {string} */
function buildDayDetailsCacheKey_(generation, dateKey) {
  return `${CALENDAR_CONFIG.detailCacheKeyPrefix}${generation}:${dateKey}`;
}

/** 読み取り専用の本番集計テストです。案件明細はログへ出しません。 */
function testGetCalendarData() {
  const response = getCalendarData();
  if (!response.ok) throw new Error(`calendar test failed: ${response.error.code}`);
  const result = response.data;
  console.log(`days: ${result.days.length}`);
  result.days.slice(0, 5).forEach((day, index) => {
    console.log(`day[${index + 1}]: date=${day.date}, count=${day.count}, level=${day.level}`);
  });
  console.log(`updatedAt: ${result.updatedAt}`);
}

/** 読み取り専用の詳細取得テストです。顧客情報はログへ出しません。 */
function testGetDayDetails() {
  const calendarResponse = getCalendarData();
  if (!calendarResponse.ok) {
    throw new Error(`calendar test failed: ${calendarResponse.error.code}`);
  }
  const calendar = calendarResponse.data;
  const populatedDay = calendar.days.find((day) => day.count > 0) || calendar.days[0];
  const detailResponse = getDayDetails(populatedDay.date);
  if (!detailResponse.ok) {
    throw new Error(`detail test failed: ${detailResponse.error.code}`);
  }
  const result = detailResponse.data;
  const allowedKeys = ['content', 'customer', 'period', 'work'];
  const keysAreSafe = result.items.every((item) => {
    return Object.keys(item).sort().join(',') === allowedKeys.join(',');
  });
  console.log(`date: ${result.date}`);
  console.log(`detail count: ${result.items.length}`);
  console.log(`allowed fields only: ${keysAreSafe}`);
}

/** @return {Array<?Date>} */
function parseDateHeaders_(values, now) {
  let previousDate = null;
  return values.map((value) => {
    const parsed = parseDateHeader_(value, now, previousDate);
    if (parsed) previousDate = parsed;
    return parsed;
  });
}

/** @return {?Date} */
function parseDateHeader_(value, now, previousDate) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  const text = trimmed_(value);
  if (!text) return null;

  let match = text.match(/^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})(?:日)?(?:\D.*)?$/);
  if (match) {
    return createValidDate_(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  match = text.match(/^(\d{1,2})[/.\-月](\d{1,2})(?:日)?(?:\D.*)?$/);
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  if (previousDate) {
    let year = previousDate.getFullYear();
    let candidate = createValidDate_(year, month, day);
    if (candidate && candidate.getTime() < previousDate.getTime()) {
      candidate = createValidDate_(year + 1, month, day);
    }
    return candidate;
  }

  const currentYear = now.getFullYear();
  const candidates = [currentYear - 1, currentYear, currentYear + 1]
    .map((year) => createValidDate_(year, month, day))
    .filter(Boolean);
  candidates.sort((left, right) => {
    return Math.abs(left.getTime() - now.getTime()) - Math.abs(right.getTime() - now.getTime());
  });
  return candidates[0] || null;
}

/** @return {?Date} */
function createValidDate_(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return null;
  return date;
}

/** @return {?string} */
function normalizeDateKey_(value) {
  const match = trimmed_(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = createValidDate_(Number(match[1]), Number(match[2]), Number(match[3]));
  return date ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/** @return {string} */
function formatDateKey_(date) {
  return Utilities.formatDate(date, CALENDAR_CONFIG.timeZone, 'yyyy-MM-dd');
}

/** @return {string} */
function normalizePeriod_(value) {
  const normalized = normalizePeriodCode_(value);
  if (normalized === 'AM' || normalized === '午前') return '午前';
  if (normalized === 'PM' || normalized === '午後') return '午後';
  return trimmed_(value);
}

/** @return {string} */
function normalizePeriodCode_(value) {
  return trimmed_(value).normalize('NFKC').replace(/\./g, '').toUpperCase();
}

/**
 * 前後の空白を除去した文字列が、集計対象工程と完全一致するかを返します。
 *
 * @param {*} value
 * @return {boolean}
 */
function isCountedWorkType_(value) {
  return COUNTED_WORK_TYPES.includes(trimmed_(value));
}

/** @return {string} */
function trimmed_(value) {
  return String(value == null ? '' : value).trim();
}

/** @return {number} */
function getCongestionLevel_(count) {
  return getCongestionRule_(count).level;
}

/** @return {{level: number, max: number, symbol: string, label: string}} */
function getCongestionRule_(count) {
  return CALENDAR_CONFIG.levels.find((candidate) => count <= candidate.max)
    || CALENDAR_CONFIG.levels[CALENDAR_CONFIG.levels.length - 1];
}
