const CALENDAR_CONFIG = Object.freeze({
  spreadsheetId: '1KOHReFlDdmJvLWX16Qram6TSogWMXwW4ddWRI6uWjfY',
  timeZone: 'Asia/Tokyo',
  headerRow: 2,
  dataStartRow: 3,
  dateStartColumn: 14,
  customerColumn: 5,
  contentColumn: 8,
  periodColumn: 13,
  endMarker: '案件数',
  detailCacheTtlSeconds: 75,
  detailCacheActiveKey: 'day-details:active:v1',
  detailCacheKeyPrefix: 'day-details:v1:',
  detailCacheMaxValueChars: 24000,
  calendarCacheKey: 'calendar-aggregate:v1',
  calendarCacheTtlSeconds: 180,
  calendarCacheMaxAgeMs: 2 * 60 * 1000,
  calendarCacheMaxValueChars: 90000,
  accessCacheKey: 'employee-access:v1',
  accessCacheTtlSeconds: 180,
  accessCacheMaxAgeMs: 150 * 1000,
  accessCacheMaxValueChars: 90000,
  maxAccessAccountCount: 1500,
  maxAccessGroupCount: 100,
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
 * アクセス中ユーザーを事前生成済み権限キャッシュで確認してから、表示キャッシュを返します。
 * 権限キャッシュが利用できない場合はSpreadsheetを開かず、安全側で拒否します。
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
 *   detailRevision: string, serverTiming: Object,
 *   timeZone: string, spreadsheetUrl: string}}
 */
function getCalendarData_() {
  const timing = createCalendarTiming_();
  const cached = getAuthorizedCalendarAggregate_(timing);
  if (cached) {
    const result = buildCachedCalendarResponse_(cached);
    return attachCalendarTiming_(result, timing, true);
  }

  const spreadsheet = openSpreadsheet_(timing);
  const result = buildFreshCalendarData_(spreadsheet, timing, true);
  timing.spreadsheetFetchCompletedMs = Date.now() - timing.startedAt;
  cacheCalendarAggregate_(result);
  delete result.sheetId;
  return attachCalendarTiming_(result, timing, false);
}

/**
 * 1分程度の時間主導トリガーから呼び出す事前集計更新関数です。
 * Spreadsheet共有権限と表示専用カレンダーを更新します。トリガー自体は作成しません。
 */
function refreshCalendarAggregateCache() {
  try {
    const timing = createCalendarTiming_();
    const spreadsheet = openSpreadsheet_(timing);
    const accessPolicyResult = buildSpreadsheetAccessPolicy_();
    cacheSpreadsheetAccessPolicy_(accessPolicyResult.policy);
    console.info(`access policy refreshed ${JSON.stringify(accessPolicyResult.stats)}`);
    const result = buildFreshCalendarData_(spreadsheet, timing, false);
    timing.spreadsheetFetchCompletedMs = Date.now() - timing.startedAt;
    cacheCalendarAggregate_(result);
    delete result.sheetId;
    attachCalendarTiming_(result, timing, false);
    return {
      ok: true,
      data: {
        updatedAt: result.updatedAt,
        dayCount: result.days.length,
        allowedAccountCount: accessPolicyResult.stats.allowedAccountCount,
        domainPermissionCount: accessPolicyResult.stats.domainPermissionCount,
        groupPermissionCount: accessPolicyResult.stats.groupPermissionCount,
        serverTiming: result.serverTiming,
      },
    };
  } catch (error) {
    return createSafeErrorResponse_(error);
  }
}

function createCalendarTiming_() {
  return {
    startedAt: Date.now(),
    permissionCheckCompletedMs: null,
    activeUserLookupMs: 0,
    accessCacheLookupMs: 0,
    serverCacheLookupCompletedMs: null,
    spreadsheetFetchCompletedMs: null,
    cacheHit: false,
    spreadsheetOpenMs: 0,
    spreadsheetReadMs: 0,
    sheetValueReadCalls: 0,
    mergedRangeReadCalls: 0,
    latestSheetResolutionMs: 0,
    aggregationMs: 0,
    revisionMs: 0,
    detailCacheWriteMs: 0,
  };
}

function openSpreadsheet_(timing) {
  const openStartedAt = Date.now();
  const spreadsheet = SpreadsheetApp.openById(CALENDAR_CONFIG.spreadsheetId);
  spreadsheet.getId();
  timing.spreadsheetOpenMs += Date.now() - openStartedAt;
  return spreadsheet;
}

function attachCalendarTiming_(result, timing, cacheHit) {
  timing.cacheHit = cacheHit;
  timing.totalMs = Date.now() - timing.startedAt;
  delete timing.startedAt;
  result.serverTiming = timing;
  console.info(`getCalendarData timing ${JSON.stringify(timing)}`);
  return result;
}

function buildFreshCalendarData_(spreadsheet, timing, cacheDetails) {
  const layout = resolveCurrentScheduleSheet_(timing, spreadsheet);
  const snapshot = readScheduleSnapshot_(layout, timing);
  const revisionStartedAt = Date.now();
  const detailRevision = buildDetailRevision_(layout.sheetId, snapshot);
  timing.revisionMs = Date.now() - revisionStartedAt;
  if (cacheDetails) {
    const cacheStartedAt = Date.now();
    cacheDayDetailsSnapshot_(
      layout.sheetId,
      snapshot.detailsByDate,
      snapshot.updatedAt,
      detailRevision,
    );
    timing.detailCacheWriteMs = Date.now() - cacheStartedAt;
  }

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
    throw new Error('N列以降の2行目に有効な日付が見つかりません。');
  }

  return {
    sheetId: layout.sheetId,
    days,
    levels: CALENDAR_CONFIG.levels.map((rule) => ({
      level: rule.level,
      symbol: rule.symbol,
      label: rule.label,
    })),
    updatedAt: snapshot.updatedAt,
    detailRevision,
    timeZone: CALENDAR_CONFIG.timeZone,
    spreadsheetUrl: buildSpreadsheetUrl_(layout.sheetId),
  };
}

function buildCachedCalendarResponse_(cached) {
  return {
    days: cached.days,
    levels: cached.levels,
    updatedAt: cached.updatedAt,
    detailRevision: cached.detailRevision,
    timeZone: CALENDAR_CONFIG.timeZone,
    spreadsheetUrl: buildSpreadsheetUrl_(cached.sheetId),
  };
}

function getAuthorizedCalendarAggregate_(timing) {
  const identityStartedAt = Date.now();
  const email = normalizeEmail_(Session.getActiveUser().getEmail());
  timing.activeUserLookupMs = Date.now() - identityStartedAt;
  if (!email) throw new Error('access denied: active user unavailable');

  let cachedValues;
  const accessCacheStartedAt = Date.now();
  try {
    const cache = CacheService.getScriptCache();
    cachedValues = cache.getAll([
      CALENDAR_CONFIG.accessCacheKey,
      CALENDAR_CONFIG.calendarCacheKey,
    ]);
  } catch (error) {
    throw new Error('access denied: access cache unavailable');
  }
  timing.accessCacheLookupMs = Date.now() - accessCacheStartedAt;

  const accessPolicy = parseCachedAccessPolicy_(
    cachedValues && cachedValues[CALENDAR_CONFIG.accessCacheKey],
  );
  if (!accessPolicy || !isEmailAllowedByPolicy_(email, accessPolicy)) {
    throw new Error('access denied: user is not allowed');
  }
  timing.permissionCheckCompletedMs = Date.now() - timing.startedAt;

  const aggregate = parseCachedCalendarAggregate_(
    cachedValues && cachedValues[CALENDAR_CONFIG.calendarCacheKey],
  );
  timing.serverCacheLookupCompletedMs = Date.now() - timing.startedAt;
  return aggregate;
}

function parseCachedCalendarAggregate_(serialized) {
  try {
    if (!serialized) return null;
    const cached = JSON.parse(serialized);
    if (!isValidCalendarAggregate_(cached)) return null;
    if (Date.now() - cached.generatedAt > CALENDAR_CONFIG.calendarCacheMaxAgeMs) return null;
    return cached;
  } catch (error) {
    return null;
  }
}

function cacheCalendarAggregate_(result) {
  try {
    const payload = {
      version: 1,
      generatedAt: Date.now(),
      sheetId: String(result.sheetId),
      days: result.days.map((day) => ({
        date: day.date,
        count: day.count,
        level: day.level,
        symbol: day.symbol,
      })),
      levels: result.levels.map((level) => ({
        level: level.level,
        symbol: level.symbol,
        label: level.label,
      })),
      updatedAt: result.updatedAt,
      detailRevision: result.detailRevision,
    };
    const serialized = JSON.stringify(payload);
    if (serialized.length > CALENDAR_CONFIG.calendarCacheMaxValueChars) return;
    CacheService.getScriptCache().put(
      CALENDAR_CONFIG.calendarCacheKey,
      serialized,
      CALENDAR_CONFIG.calendarCacheTtlSeconds,
    );
  } catch (error) {
    console.warn('calendar aggregate cache write skipped');
  }
}

function isValidCalendarAggregate_(cached) {
  if (
    !cached
    || cached.version !== 1
    || !Number.isFinite(cached.generatedAt)
    || cached.generatedAt > Date.now() + 60 * 1000
    || typeof cached.sheetId !== 'string'
    || !/^\d+$/.test(cached.sheetId)
    || !Array.isArray(cached.days)
    || cached.days.length === 0
    || cached.days.length > 1000
    || !Array.isArray(cached.levels)
    || cached.levels.length !== CALENDAR_CONFIG.levels.length
    || typeof cached.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(cached.updatedAt))
    || typeof cached.detailRevision !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(cached.detailRevision)
  ) return false;

  const levelsAreValid = cached.levels.every((level, index) => {
    const expected = CALENDAR_CONFIG.levels[index];
    return level
      && level.level === expected.level
      && level.symbol === expected.symbol
      && level.label === expected.label;
  });
  if (!levelsAreValid) return false;

  return cached.days.every((day) => {
    if (
      !day
      || typeof day.date !== 'string'
      || normalizeDateKey_(day.date) !== day.date
      || !Number.isInteger(day.count)
      || day.count < 0
      || !Number.isInteger(day.level)
    ) return false;
    const expected = getCongestionRule_(day.count);
    return day.level === expected.level && day.symbol === expected.symbol;
  });
}

function parseCachedAccessPolicy_(serialized) {
  try {
    if (!serialized) return null;
    const policy = JSON.parse(serialized);
    if (!isValidAccessPolicy_(policy)) return null;
    if (Date.now() - policy.generatedAt > CALENDAR_CONFIG.accessCacheMaxAgeMs) return null;
    return policy;
  } catch (error) {
    return null;
  }
}

function isValidAccessPolicy_(policy) {
  if (
    !policy
    || policy.version !== 1
    || !Number.isFinite(policy.generatedAt)
    || policy.generatedAt > Date.now() + 60 * 1000
    || !Array.isArray(policy.allowedEmailHashes)
    || policy.allowedEmailHashes.length > CALENDAR_CONFIG.maxAccessAccountCount
    || !Array.isArray(policy.allowedDomains)
    || policy.allowedDomains.length > 100
    || typeof policy.allowAnyAuthenticated !== 'boolean'
  ) return false;

  return policy.allowedEmailHashes.every((value) => (
    typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  )) && policy.allowedDomains.every((value) => (
    typeof value === 'string'
    && value === value.toLowerCase()
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)
  ));
}

function isEmailAllowedByPolicy_(email, policy) {
  if (policy.allowAnyAuthenticated) return true;
  if (policy.allowedEmailHashes.includes(hashEmail_(email))) return true;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return policy.allowedDomains.includes(domain);
}

function normalizeEmail_(value) {
  const email = String(value == null ? '' : value).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function hashEmail_(email) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    email,
    Utilities.Charset.UTF_8,
  );
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
}

function buildSpreadsheetAccessPolicy_() {
  const permissions = listSpreadsheetPermissions_();
  const allowedEmails = new Set();
  const allowedDomains = new Set();
  const visitedGroups = new Set();
  let allowAnyAuthenticated = false;
  let groupPermissionCount = 0;
  let domainPermissionCount = 0;

  permissions.forEach((permission) => {
    if (!isReadableDrivePermission_(permission)) return;
    if (permission.type === 'user') {
      addAllowedEmail_(allowedEmails, permission.emailAddress);
      return;
    }
    if (permission.type === 'group') {
      const groupEmail = normalizeEmail_(permission.emailAddress);
      if (!groupEmail) throw new Error('invalid Google Group permission');
      groupPermissionCount += 1;
      addGoogleGroupMembers_(groupEmail, allowedEmails, visitedGroups);
      return;
    }
    if (permission.type === 'domain') {
      if (permission.allowFileDiscovery !== true) return;
      const domain = normalizeDomain_(permission.domain);
      if (!domain) throw new Error('invalid domain permission');
      allowedDomains.add(domain);
      domainPermissionCount += 1;
      return;
    }
    if (permission.type === 'anyone' && permission.allowFileDiscovery === true) {
      allowAnyAuthenticated = true;
    }
  });

  const policy = {
    version: 1,
    generatedAt: Date.now(),
    allowedEmailHashes: Array.from(allowedEmails, hashEmail_).sort(),
    allowedDomains: Array.from(allowedDomains).sort(),
    allowAnyAuthenticated,
  };
  if (!isValidAccessPolicy_(policy)) throw new Error('access policy validation failed');
  return {
    policy,
    stats: {
      allowedAccountCount: policy.allowedEmailHashes.length,
      domainPermissionCount,
      groupPermissionCount,
    },
  };
}

function listSpreadsheetPermissions_() {
  const permissions = [];
  let pageToken;
  do {
    const options = {
      fields: 'nextPageToken,permissions(type,role,emailAddress,domain,allowFileDiscovery,deleted,expirationTime)',
      pageSize: 100,
      supportsAllDrives: true,
    };
    if (pageToken) options.pageToken = pageToken;
    const page = Drive.Permissions.list(CALENDAR_CONFIG.spreadsheetId, options);
    (page.permissions || []).forEach((permission) => permissions.push(permission));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return permissions;
}

function isReadableDrivePermission_(permission) {
  if (!permission || permission.deleted) return false;
  if (permission.expirationTime) {
    const expiration = Date.parse(permission.expirationTime);
    if (!Number.isFinite(expiration)) throw new Error('invalid permission expiration');
    if (expiration <= Date.now()) return false;
  }
  return [
    'owner',
    'organizer',
    'fileOrganizer',
    'writer',
    'commenter',
    'reader',
  ].includes(permission.role);
}

function addGoogleGroupMembers_(groupEmail, allowedEmails, visitedGroups) {
  if (visitedGroups.has(groupEmail)) return;
  if (visitedGroups.size >= CALENDAR_CONFIG.maxAccessGroupCount) {
    throw new Error('Google Group limit exceeded');
  }
  visitedGroups.add(groupEmail);

  const group = GroupsApp.getGroupByEmail(groupEmail);
  const users = group.getUsers();
  const roles = group.getRoles(users);
  users.forEach((user, index) => {
    if (!isActiveGoogleGroupRole_(roles[index])) return;
    addAllowedEmail_(allowedEmails, user.getEmail());
  });
  group.getGroups().forEach((childGroup) => {
    const childEmail = normalizeEmail_(childGroup.getEmail());
    if (!childEmail) throw new Error('invalid nested Google Group');
    addGoogleGroupMembers_(childEmail, allowedEmails, visitedGroups);
  });
}

function isActiveGoogleGroupRole_(role) {
  return role === GroupsApp.Role.OWNER
    || role === GroupsApp.Role.MANAGER
    || role === GroupsApp.Role.MEMBER;
}

function addAllowedEmail_(allowedEmails, value) {
  const email = normalizeEmail_(value);
  if (!email) return;
  allowedEmails.add(email);
  if (allowedEmails.size > CALENDAR_CONFIG.maxAccessAccountCount) {
    throw new Error('access account limit exceeded');
  }
}

function normalizeDomain_(value) {
  const domain = String(value == null ? '' : value).trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) ? domain : '';
}

function cacheSpreadsheetAccessPolicy_(policy) {
  const serialized = JSON.stringify(policy);
  if (serialized.length > CALENDAR_CONFIG.accessCacheMaxValueChars) {
    throw new Error('access cache size exceeded');
  }
  CacheService.getScriptCache().put(
    CALENDAR_CONFIG.accessCacheKey,
    serialized,
    CALENDAR_CONFIG.accessCacheTtlSeconds,
  );
}

function verifyCachedUserAccess_() {
  const email = normalizeEmail_(Session.getActiveUser().getEmail());
  if (!email) throw new Error('access denied: active user unavailable');
  let serialized;
  try {
    serialized = CacheService.getScriptCache().get(CALENDAR_CONFIG.accessCacheKey);
  } catch (error) {
    throw new Error('access denied: access cache unavailable');
  }
  const policy = parseCachedAccessPolicy_(serialized);
  if (!policy || !isEmailAllowedByPolicy_(email, policy)) {
    throw new Error('access denied: user is not allowed');
  }
}

/**
 * 指定された1日分だけの案件詳細を読み取ります。
 * 返す項目は客先名、内容、当日の作業内容、AM/PMに限定します。
 *
 * @param {string} dateKey yyyy-MM-dd形式の日付
 * @param {string=} expectedRevision ブラウザーが表示中のカレンダーrevision
 * @return {{ok: boolean, data: Object}|{ok: false, error: {code: string}}}
 */
function getDayDetails(dateKey, expectedRevision) {
  try {
    return { ok: true, data: getDayDetails_(dateKey, expectedRevision) };
  } catch (error) {
    return createSafeErrorResponse_(error);
  }
}

/**
 * @param {string} dateKey yyyy-MM-dd形式の日付
 * @param {string=} expectedRevision ブラウザーが表示中のカレンダーrevision
 * @return {{date: string,
 *   items: Array<{customer: string, content: string, work: string, period: string}>,
 *   updatedAt: string, revision: string}}
 */
function getDayDetails_(dateKey, expectedRevision) {
  verifyCachedUserAccess_();
  const normalizedDateKey = normalizeDateKey_(dateKey);
  if (!normalizedDateKey) {
    throw new Error('日付はyyyy-MM-dd形式で指定してください。');
  }

  const cached = getCachedDayDetails_(normalizedDateKey, expectedRevision);
  if (cached) {
    cached.items = sortDayDetailItems_(cached.items);
    return cached;
  }

  const layout = resolveCurrentScheduleSheet_();
  const snapshot = readScheduleSnapshot_(layout);
  const detailRevision = buildDetailRevision_(layout.sheetId, snapshot);
  cacheDayDetailsSnapshot_(
    layout.sheetId,
    snapshot.detailsByDate,
    snapshot.updatedAt,
    detailRevision,
  );
  return {
    date: normalizedDateKey,
    items: sortDayDetailItems_(snapshot.detailsByDate[normalizedDateKey] || []),
    updatedAt: snapshot.updatedAt,
    revision: detailRevision,
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
 *   dateColumnCount: number, parsedHeaders: Array<?Date>,
 *   displayValues: Array<Array<string>>}}
 */
function resolveCurrentScheduleSheet_(timing, openedSpreadsheet) {
  const resolutionStartedAt = Date.now();
  let spreadsheet = openedSpreadsheet;
  if (!spreadsheet) {
    const openStartedAt = Date.now();
    spreadsheet = SpreadsheetApp.openById(CALENDAR_CONFIG.spreadsheetId);
    if (timing) timing.spreadsheetOpenMs += Date.now() - openStartedAt;
  }
  const sheets = spreadsheet.getSheets();
  const now = new Date();
  for (let index = 0; index < sheets.length; index += 1) {
    const layout = inspectScheduleSheet_(sheets[index], now, timing);
    if (layout) {
      if (timing) timing.latestSheetResolutionMs = Date.now() - resolutionStartedAt;
      return layout;
    }
  }

  throw new Error('有効なスケジュールシートが見つかりません。');
}

/**
 * 1枚のシートが運用中のスケジュール形式を満たすか、読み取りだけで検査します。
 *
 * @param {Sheet} sheet
 * @param {Date} now
 * @return {?{sheet: Sheet, sheetId: number, dataRowCount: number,
 *   dateColumnCount: number, parsedHeaders: Array<?Date>,
 *   displayValues: Array<Array<string>>}}
 */
function inspectScheduleSheet_(sheet, now, timing) {
  if (sheet.isSheetHidden()) return null;

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (
    lastRow <= CALENDAR_CONFIG.dataStartRow
    || lastColumn < CALENDAR_CONFIG.dateStartColumn
  ) return null;

  const sheetReadStartedAt = Date.now();
  const loadedRange = sheet.getRange(
    CALENDAR_CONFIG.headerRow,
    1,
    lastRow - CALENDAR_CONFIG.headerRow + 1,
    lastColumn,
  );
  const displayValues = loadedRange.getDisplayValues();
  if (timing) {
    timing.spreadsheetReadMs += Date.now() - sheetReadStartedAt;
    timing.sheetValueReadCalls += 1;
  }
  const dataRowOffset = CALENDAR_CONFIG.dataStartRow - CALENDAR_CONFIG.headerRow;
  const markerOffset = displayValues.slice(dataRowOffset).findIndex(
    (row) => String(row[0] == null ? '' : row[0]) === CALENDAR_CONFIG.endMarker,
  );
  if (markerOffset <= 0) return null;

  const dateColumnCount = lastColumn - CALENDAR_CONFIG.dateStartColumn + 1;
  const headerValues = displayValues[0].slice(
    CALENDAR_CONFIG.dateStartColumn - 1,
    CALENDAR_CONFIG.dateStartColumn - 1 + dateColumnCount,
  );
  const parsedHeaders = parseDateHeaders_(headerValues, now);
  if (!parsedHeaders.some((date) => Boolean(date))) return null;

  return {
    sheet,
    sheetId: sheet.getSheetId(),
    dataRowCount: markerOffset,
    dateColumnCount,
    parsedHeaders,
    displayValues,
  };
}

/** @return {string} */
function buildSpreadsheetUrl_(sheetId) {
  return `https://docs.google.com/spreadsheets/d/${CALENDAR_CONFIG.spreadsheetId}/edit?gid=${sheetId}`;
}

/**
 * E列から日付領域末尾までを1回で読み取り、混雑数と日付別詳細を同時に作成します。
 * 結合範囲はE〜H列を1回だけ調べ、E/H列の空欄値を左上値で補完します。
 * AM/PMは、結合されたL列（納品方法）ではなく、工程と同じ行のM列から直接取得します。
 *
 * @param {{sheet: Sheet, sheetId: number, dataRowCount: number,
 *   dateColumnCount: number, parsedHeaders: Array<?Date>,
 *   displayValues: Array<Array<string>>}} layout
 * @return {{countsByDate: Object<string, number>,
 *   detailsByDate: Object<string, Array<Object>>, updatedAt: string}}
 */
function readScheduleSnapshot_(layout, timing) {
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

  const dataRowOffset = startRow - CALENDAR_CONFIG.headerRow;
  const dataValues = layout.displayValues
    .slice(dataRowOffset, dataRowOffset + layout.dataRowCount)
    .map((row) => row.slice(startColumn - 1, startColumn - 1 + columnCount));
  const mergedReadStartedAt = Date.now();
  const mergedRanges = layout.sheet
    .getRange(
      startRow,
      CALENDAR_CONFIG.customerColumn,
      layout.dataRowCount,
      CALENDAR_CONFIG.contentColumn - CALENDAR_CONFIG.customerColumn + 1,
    )
    .getMergedRanges();
  if (timing) {
    timing.spreadsheetReadMs += Date.now() - mergedReadStartedAt;
    timing.mergedRangeReadCalls += 1;
  }
  const aggregationStartedAt = Date.now();
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

  if (timing) timing.aggregationMs += Date.now() - aggregationStartedAt;

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
function cacheDayDetailsSnapshot_(sheetId, detailsByDate, updatedAt, revision) {
  try {
    const cache = CacheService.getUserCache();
    const generation = `${sheetId}:${revision}`;
    const cacheValues = {};
    Object.keys(detailsByDate).forEach((date) => {
      const serialized = JSON.stringify({
        date,
        items: sortDayDetailItems_(detailsByDate[date]),
        updatedAt,
        revision,
      });
      if (serialized.length <= CALENDAR_CONFIG.detailCacheMaxValueChars) {
        cacheValues[buildDayDetailsCacheKey_(generation, date)] = serialized;
      }
    });
    if (Object.keys(cacheValues).length > 0) {
      cache.putAll(cacheValues, CALENDAR_CONFIG.detailCacheTtlSeconds);
    }
    cache.put(
      CALENDAR_CONFIG.detailCacheActiveKey,
      JSON.stringify({ generation, sheetId: String(sheetId), revision }),
      CALENDAR_CONFIG.detailCacheTtlSeconds,
    );
  } catch (error) {
    console.warn('day details cache write skipped');
  }
}

/** @return {?{date: string, items: Array<Object>, updatedAt: string, revision: string}} */
function getCachedDayDetails_(dateKey, expectedRevision) {
  try {
    const cache = CacheService.getUserCache();
    const activeText = cache.get(CALENDAR_CONFIG.detailCacheActiveKey);
    if (!activeText) return null;
    const active = JSON.parse(activeText);
    if (
      !active
      || typeof active.generation !== 'string'
      || typeof active.revision !== 'string'
    ) return null;
    if (
      typeof expectedRevision === 'string'
      && expectedRevision
      && active.revision !== expectedRevision
    ) return null;
    const cachedText = cache.get(buildDayDetailsCacheKey_(active.generation, dateKey));
    if (!cachedText) return null;
    const cached = JSON.parse(cachedText);
    if (
      !cached
      || cached.date !== dateKey
      || !Array.isArray(cached.items)
      || cached.revision !== active.revision
    ) return null;
    return cached;
  } catch (error) {
    return null;
  }
}

/**
 * カレンダー更新時刻ではなく、詳細表示に影響する実データから安定したrevisionを作ります。
 * Spreadsheetの内容が同じなら60秒更新後も同じ値になり、変更時だけ切り替わります。
 *
 * @return {string}
 */
function buildDetailRevision_(sheetId, snapshot) {
  const source = JSON.stringify({
    schema: 1,
    sheetId: String(sheetId),
    countsByDate: snapshot.countsByDate,
    detailsByDate: snapshot.detailsByDate,
  });
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    source,
    Utilities.Charset.UTF_8,
  );
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
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
  if (normalized === 'AM' || normalized === '午前') return 'AM';
  if (normalized === 'PM' || normalized === '午後') return 'PM';
  return '';
}

/**
 * AM、PM、期間なし・未知値の順へ並べ、同じ時間帯では元の行順を維持します。
 * Array#sortに依存せず、元配列も変更しない安定したバケット分けです。
 *
 * @param {Array<Object>} items
 * @return {Array<Object>}
 */
function sortDayDetailItems_(items) {
  const buckets = [[], [], []];
  items.forEach((item) => {
    const period = normalizePeriod_(item && item.period);
    const rank = period === 'AM' ? 0 : period === 'PM' ? 1 : 2;
    buckets[rank].push(item);
  });
  return buckets[0].concat(buckets[1], buckets[2]);
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
