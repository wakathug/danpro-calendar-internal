import { callGas, GasAccessDeniedError } from './_lib/gas-client.js';
import { queryValue, requireMethod, sendJson } from './_lib/http.js';
import { elapsedMs, logPerformance, serverTiming, startTimer } from './_lib/performance.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import {
  authorizationResponse,
  clearSessionCookie,
  deleteSession,
  readSession,
  updateSessionAuthorization,
} from './_lib/session.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REVISION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isValidDate(value) {
  if (!DATE_PATTERN.test(value ?? '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  const startedAt = startTimer();
  const timing = {};
  let current;
  try {
    current = await readSession(req, Date.now(), timing);
    if (!current) {
      timing.total = elapsedMs(startedAt);
      logPerformance('day_details', 401, timing);
      return sendJson(res, 401, { error: 'UNAUTHENTICATED' }, {
        'Set-Cookie': clearSessionCookie(),
        'Server-Timing': serverTiming(timing),
      });
    }
    const date = queryValue(req, 'date');
    const revisionValue = queryValue(req, 'revision');
    if (!isValidDate(date)) {
      timing.total = elapsedMs(startedAt);
      logPerformance('day_details', 400, timing);
      return sendJson(res, 400, { error: 'INVALID_DATE' }, {
        'Server-Timing': serverTiming(timing),
      });
    }
    if (revisionValue && !REVISION_PATTERN.test(revisionValue)) {
      timing.total = elapsedMs(startedAt);
      logPerformance('day_details', 400, timing);
      return sendJson(res, 400, { error: 'INVALID_REVISION' }, {
        'Server-Timing': serverTiming(timing),
      });
    }
    const rateLimitStartedAt = startTimer();
    const allowed = await checkRateLimit('day-details', current.sessionId, 180, 60);
    timing.rateLimit = elapsedMs(rateLimitStartedAt);
    if (!allowed) {
      timing.total = elapsedMs(startedAt);
      logPerformance('day_details', 429, timing);
      return sendJson(res, 429, { error: 'RATE_LIMITED' }, {
        'Server-Timing': serverTiming(timing),
      });
    }
    const authorizationStartedAt = Date.now();
    const data = await callGas('dayDetails', current.session.email, {
      date,
      expectedRevision: revisionValue || '',
    }, {
      onTiming: (gasTiming) => Object.assign(timing, gasTiming),
    });
    const lastAuthorizedAt = await updateSessionAuthorization(
      current.sessionId,
      authorizationStartedAt,
    );
    if (!lastAuthorizedAt) {
      timing.total = elapsedMs(startedAt);
      logPerformance('day_details', 401, timing);
      return sendJson(res, 401, { error: 'UNAUTHENTICATED' }, {
        'Set-Cookie': clearSessionCookie(),
        'Server-Timing': serverTiming(timing),
      });
    }
    timing.total = elapsedMs(startedAt);
    logPerformance('day_details', 200, timing);
    sendJson(res, 200, {
      ok: true,
      data,
      authorization: authorizationResponse(lastAuthorizedAt),
    }, {
      'Server-Timing': serverTiming(timing),
    });
  } catch (error) {
    timing.total = elapsedMs(startedAt);
    if (error instanceof GasAccessDeniedError) {
      if (current) await deleteSession(current.sessionId).catch(() => {});
      logPerformance('day_details', 403, timing);
      return sendJson(res, 403, { ok: false, error: { code: 'ACCESS_DENIED' } }, {
        'Set-Cookie': clearSessionCookie(),
        'Server-Timing': serverTiming(timing),
      });
    }
    logPerformance('day_details', 503, timing);
    sendJson(res, 503, { error: 'DATA_UNAVAILABLE' }, {
      'Server-Timing': serverTiming(timing),
    });
  }
}
