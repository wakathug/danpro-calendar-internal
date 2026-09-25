import { callGas, GasAccessDeniedError } from './_lib/gas-client.js';
import { queryValue, requireMethod, sendJson } from './_lib/http.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { clearSessionCookie, deleteSession, readSession } from './_lib/session.js';

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
  let current;
  try {
    current = await readSession(req);
    if (!current) return sendJson(res, 401, { error: 'UNAUTHENTICATED' });
    const date = queryValue(req, 'date');
    const revisionValue = queryValue(req, 'revision');
    if (!isValidDate(date)) return sendJson(res, 400, { error: 'INVALID_DATE' });
    if (revisionValue && !REVISION_PATTERN.test(revisionValue)) {
      return sendJson(res, 400, { error: 'INVALID_REVISION' });
    }
    const allowed = await checkRateLimit('day-details', current.sessionId, 180, 60);
    if (!allowed) return sendJson(res, 429, { error: 'RATE_LIMITED' });
    const data = await callGas('dayDetails', current.session.email, {
      date,
      expectedRevision: revisionValue || '',
    });
    sendJson(res, 200, { ok: true, data });
  } catch (error) {
    if (error instanceof GasAccessDeniedError) {
      if (current) await deleteSession(current.sessionId).catch(() => {});
      return sendJson(res, 403, { ok: false, error: { code: 'ACCESS_DENIED' } }, { 'Set-Cookie': clearSessionCookie() });
    }
    sendJson(res, 503, { error: 'DATA_UNAVAILABLE' });
  }
}
