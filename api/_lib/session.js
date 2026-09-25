import { normalizeEmail, randomToken, sha256 } from './crypto.js';
import { parseCookies, secureCookie, clearCookie } from './http.js';
import { storeDelete, storeGet, storeSet } from './store.js';

export const SESSION_COOKIE = '__Host-danpro_session';
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function sessionKey(sessionId) {
  return `session:v1:${sha256(sessionId)}`;
}

export async function createSession(email, now = Date.now()) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error('Cannot create session without a valid identity');
  const sessionId = randomToken(32);
  const session = {
    version: 1,
    email: normalizedEmail,
    createdAt: now,
    expiresAt: now + SESSION_MAX_AGE_SECONDS * 1000,
  };
  await storeSet(sessionKey(sessionId), session, SESSION_MAX_AGE_SECONDS);
  return {
    sessionId,
    session,
    cookie: secureCookie(SESSION_COOKIE, sessionId, SESSION_MAX_AGE_SECONDS),
  };
}

export async function readSession(req, now = Date.now()) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (!SESSION_ID_PATTERN.test(sessionId ?? '')) return null;
  const session = await storeGet(sessionKey(sessionId));
  if (
    !session
    || session.version !== 1
    || !normalizeEmail(session.email)
    || !Number.isFinite(session.createdAt)
    || !Number.isFinite(session.expiresAt)
    || session.expiresAt <= now
    || session.expiresAt - session.createdAt > SESSION_MAX_AGE_SECONDS * 1000 + 1000
  ) {
    await storeDelete(sessionKey(sessionId));
    return null;
  }
  return { sessionId, session };
}

export async function deleteSession(sessionId) {
  if (SESSION_ID_PATTERN.test(sessionId ?? '')) {
    await storeDelete(sessionKey(sessionId));
  }
}

export async function deleteRequestSession(req) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  await deleteSession(sessionId);
}

export function clearSessionCookie() {
  return clearCookie(SESSION_COOKIE);
}

