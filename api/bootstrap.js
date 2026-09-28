import { hmacSha256, normalizeEmail } from './_lib/crypto.js';
import { getConfig } from './_lib/config.js';
import { callGas, GasAccessDeniedError } from './_lib/gas-client.js';
import { requireMethod, sendJson } from './_lib/http.js';
import { elapsedMs, logPerformance, serverTiming, startTimer } from './_lib/performance.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { clearSessionCookie, deleteSession, readSession } from './_lib/session.js';

function anonymousUserKey(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error('Invalid authenticated identity');
  return hmacSha256(getConfig().gasSigningSecret, `browser-cache:v1\n${normalized}`);
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
      logPerformance('bootstrap', 401, timing);
      return sendJson(res, 401, { authenticated: false }, {
        'Set-Cookie': clearSessionCookie(),
        'Server-Timing': serverTiming(timing),
      });
    }
    const rateLimitStartedAt = startTimer();
    const allowed = await checkRateLimit('bootstrap', current.sessionId, 90, 60);
    timing.rateLimit = elapsedMs(rateLimitStartedAt);
    if (!allowed) {
      timing.total = elapsedMs(startedAt);
      logPerformance('bootstrap', 429, timing);
      return sendJson(res, 429, { error: 'RATE_LIMITED' }, {
        'Server-Timing': serverTiming(timing),
      });
    }
    const data = await callGas('calendar', current.session.email, {}, {
      onTiming: (gasTiming) => Object.assign(timing, gasTiming),
    });
    timing.total = elapsedMs(startedAt);
    logPerformance('bootstrap', 200, timing);
    sendJson(res, 200, {
      ok: true,
      authenticated: true,
      userCacheKey: anonymousUserKey(current.session.email),
      data,
    }, { 'Server-Timing': serverTiming(timing) });
  } catch (error) {
    timing.total = elapsedMs(startedAt);
    if (error instanceof GasAccessDeniedError) {
      if (current) await deleteSession(current.sessionId).catch(() => {});
      logPerformance('bootstrap', 403, timing);
      return sendJson(res, 403, { authenticated: false }, {
        'Set-Cookie': clearSessionCookie(),
        'Server-Timing': serverTiming(timing),
      });
    }
    logPerformance('bootstrap', 503, timing);
    sendJson(res, 503, { error: 'DATA_UNAVAILABLE' }, {
      'Server-Timing': serverTiming(timing),
    });
  }
}
