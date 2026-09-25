import { callGas, GasAccessDeniedError } from './_lib/gas-client.js';
import { requireMethod, sendJson } from './_lib/http.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { clearSessionCookie, deleteSession, readSession } from './_lib/session.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  let current;
  try {
    current = await readSession(req);
    if (!current) return sendJson(res, 401, { error: 'UNAUTHENTICATED' });
    const allowed = await checkRateLimit('calendar', current.sessionId, 90, 60);
    if (!allowed) return sendJson(res, 429, { error: 'RATE_LIMITED' });
    const data = await callGas('calendar', current.session.email);
    sendJson(res, 200, { ok: true, data });
  } catch (error) {
    if (error instanceof GasAccessDeniedError) {
      if (current) await deleteSession(current.sessionId).catch(() => {});
      return sendJson(res, 403, { ok: false, error: { code: 'ACCESS_DENIED' } }, { 'Set-Cookie': clearSessionCookie() });
    }
    sendJson(res, 503, { error: 'DATA_UNAVAILABLE' });
  }
}
