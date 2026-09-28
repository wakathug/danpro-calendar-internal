import { callGas, GasAccessDeniedError } from './_lib/gas-client.js';
import { requireMethod, sendJson } from './_lib/http.js';
import { elapsedMs, logPerformance, serverTiming, startTimer } from './_lib/performance.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import {
  authorizationResponse,
  clearSessionCookie,
  deleteSession,
  readSession,
  updateSessionAuthorization,
} from './_lib/session.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  const startedAt = startTimer();
  const timing = {};
  let current;
  try {
    current = await readSession(req, Date.now(), timing);
    if (!current) return sendJson(res, 401, { error: 'UNAUTHENTICATED' }, {
      'Set-Cookie': clearSessionCookie(),
    });
    const allowed = await checkRateLimit('calendar', current.sessionId, 90, 60);
    if (!allowed) return sendJson(res, 429, { error: 'RATE_LIMITED' });
    const authorizationStartedAt = Date.now();
    const data = await callGas('calendar', current.session.email, {}, {
      onTiming: (gasTiming) => Object.assign(timing, gasTiming),
    });
    const lastAuthorizedAt = await updateSessionAuthorization(
      current.sessionId,
      authorizationStartedAt,
    );
    if (!lastAuthorizedAt) {
      timing.total = elapsedMs(startedAt);
      logPerformance('calendar', 401, timing);
      return sendJson(res, 401, { error: 'UNAUTHENTICATED' }, {
        'Set-Cookie': clearSessionCookie(),
        'Server-Timing': serverTiming(timing),
      });
    }
    timing.total = elapsedMs(startedAt);
    logPerformance('calendar', 200, timing);
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
      logPerformance('calendar', 403, timing);
      return sendJson(res, 403, { ok: false, error: { code: 'ACCESS_DENIED' } }, {
        'Set-Cookie': clearSessionCookie(),
        'Server-Timing': serverTiming(timing),
      });
    }
    logPerformance('calendar', 503, timing);
    sendJson(res, 503, { error: 'DATA_UNAVAILABLE' }, {
      'Server-Timing': serverTiming(timing),
    });
  }
}
