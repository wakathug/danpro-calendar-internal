import { authorizeEmployee, GasAccessDeniedError } from '../_lib/gas-client.js';
import { requestIp, requireMethod, sendJson } from '../_lib/http.js';
import { checkRateLimit } from '../_lib/rate-limit.js';
import {
  clearSessionCookie,
  deleteSession,
  readSession,
} from '../_lib/session.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  try {
    const allowed = await checkRateLimit('auth-session', requestIp(req), 120, 60);
    if (!allowed) return sendJson(res, 429, { error: 'RATE_LIMITED' });
    const current = await readSession(req);
    if (!current) {
      return sendJson(res, 401, { authenticated: false }, { 'Set-Cookie': clearSessionCookie() });
    }
    await authorizeEmployee(current.session.email);
    sendJson(res, 200, { authenticated: true });
  } catch (error) {
    if (error instanceof GasAccessDeniedError) {
      const current = await readSession(req).catch(() => null);
      if (current) await deleteSession(current.sessionId);
      return sendJson(res, 403, { authenticated: false }, { 'Set-Cookie': clearSessionCookie() });
    }
    sendJson(res, 503, { error: 'SESSION_UNAVAILABLE' });
  }
}
