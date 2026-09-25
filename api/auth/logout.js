import { getConfig } from '../_lib/config.js';
import { hasValidOrigin, requestIp, requireMethod, sendEmpty, sendJson } from '../_lib/http.js';
import { checkRateLimit } from '../_lib/rate-limit.js';
import { clearSessionCookie, deleteRequestSession } from '../_lib/session.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const config = getConfig();
    if (!hasValidOrigin(req, config.appOrigin)) {
      return sendJson(res, 403, { error: 'INVALID_ORIGIN' });
    }
    const allowed = await checkRateLimit('auth-logout', requestIp(req), 30, 10 * 60);
    if (!allowed) return sendJson(res, 429, { error: 'RATE_LIMITED' });
    await deleteRequestSession(req);
    sendEmpty(res, 204, { 'Set-Cookie': clearSessionCookie() });
  } catch {
    sendJson(res, 503, { error: 'LOGOUT_UNAVAILABLE' });
  }
}
