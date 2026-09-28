import { authorizeEmployee, GasAccessDeniedError } from '../_lib/gas-client.js';
import { getConfig } from '../_lib/config.js';
import { hmacSha256, normalizeEmail } from '../_lib/crypto.js';
import { requestIp, requireMethod, sendJson } from '../_lib/http.js';
import { elapsedMs, logPerformance, serverTiming, startTimer } from '../_lib/performance.js';
import { checkRateLimit } from '../_lib/rate-limit.js';
import {
  clearSessionCookie,
  deleteSession,
  readSession,
} from '../_lib/session.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  const startedAt = startTimer();
  const timing = {};
  let current;
  try {
    const allowed = await checkRateLimit('auth-session', requestIp(req), 120, 60);
    if (!allowed) return sendJson(res, 429, { error: 'RATE_LIMITED' });
    current = await readSession(req, Date.now(), timing);
    if (!current) {
      timing.total = elapsedMs(startedAt);
      logPerformance('auth_session', 401, timing);
      return sendJson(res, 401, { authenticated: false }, {
        'Set-Cookie': clearSessionCookie(),
        'Server-Timing': serverTiming(timing),
      });
    }
    await authorizeEmployee(current.session.email, {
      onTiming: (gasTiming) => Object.assign(timing, gasTiming),
    });
    const userCacheKey = hmacSha256(
      getConfig().gasSigningSecret,
      `browser-cache:v1\n${normalizeEmail(current.session.email)}`,
    );
    timing.total = elapsedMs(startedAt);
    logPerformance('auth_session', 200, timing);
    sendJson(res, 200, { authenticated: true, userCacheKey }, {
      'Server-Timing': serverTiming(timing),
    });
  } catch (error) {
    if (error instanceof GasAccessDeniedError) {
      if (current) await deleteSession(current.sessionId);
      timing.total = elapsedMs(startedAt);
      logPerformance('auth_session', 403, timing);
      return sendJson(res, 403, { authenticated: false }, {
        'Set-Cookie': clearSessionCookie(),
        'Server-Timing': serverTiming(timing),
      });
    }
    timing.total = elapsedMs(startedAt);
    logPerformance('auth_session', 503, timing);
    sendJson(res, 503, { error: 'SESSION_UNAVAILABLE' }, {
      'Server-Timing': serverTiming(timing),
    });
  }
}
